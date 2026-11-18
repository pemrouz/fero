// E-54: a small persistent hash array mapped trie (HAMT), written here as the lean floor beside Immutable.js.
// Bagwell's trie with Clojure's path copying: 32 ways a level, a bitmap per node, only the occupied slots
// stored; a write copies the nodes on one root-to-leaf path (about log32 n of them) and shares the rest.
// Keys are strings (FNV-1a hash); full-hash collisions go into a collision node. No transients, no deletes
// that shrink nodes (a delete leaves a smaller node; an empty node is dropped from its parent).
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }
const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24 }

class Leaf { constructor(h, k, v) { this.h = h; this.k = k; this.v = v } }
class Coll { constructor(h, ks, vs) { this.h = h; this.ks = ks; this.vs = vs } }
class Node { constructor(bm, a) { this.bm = bm; this.a = a } }
export const EMPTY = new Node(0, [])

export const get = (root, k) => {
  const h = fnv(k)
  let n = root, sh = 0
  for (;;) {
    const bit = 1 << ((h >>> sh) & 31)
    if ((n.bm & bit) === 0) return undefined
    const e = n.a[pop(n.bm & (bit - 1))]
    if (e instanceof Leaf) return e.k === k ? e.v : undefined
    if (e instanceof Coll) { const i = e.ks.indexOf(k); return i < 0 ? undefined : e.vs[i] }
    n = e; sh += 5
  }
}

const merge = (a, b, sh) => { // two entries (Leaf or Coll) with different hashes, under a new node at level sh
  if (sh >= 32) throw new Error('hamt: depth')
  const ia = (a.h >>> sh) & 31, ib = (b.h >>> sh) & 31
  if (ia === ib) return new Node(1 << ia, [merge(a, b, sh + 5)])
  return ia < ib ? new Node((1 << ia) | (1 << ib), [a, b]) : new Node((1 << ia) | (1 << ib), [b, a])
}

const setIn = (n, h, k, v, sh) => {
  const bit = 1 << ((h >>> sh) & 31)
  const i = pop(n.bm & (bit - 1))
  if ((n.bm & bit) === 0) {
    const a = n.a.slice(); a.splice(i, 0, new Leaf(h, k, v))
    return new Node(n.bm | bit, a)
  }
  const e = n.a[i]
  let ne
  if (e instanceof Leaf) {
    if (e.k === k) { if (e.v === v) return n; ne = new Leaf(h, k, v) }
    else if (e.h === h) ne = new Coll(h, [e.k, k], [e.v, v])
    else ne = merge(e, new Leaf(h, k, v), sh + 5)
  } else if (e instanceof Coll) {
    if (e.h === h) { const j = e.ks.indexOf(k); const ks = e.ks.slice(), vs = e.vs.slice(); if (j < 0) { ks.push(k); vs.push(v) } else vs[j] = v; ne = new Coll(h, ks, vs) }
    else ne = merge(e, new Leaf(h, k, v), sh + 5)
  } else ne = setIn(e, h, k, v, sh + 5)
  const a = n.a.slice(); a[i] = ne
  return new Node(n.bm, a)
}
export const set = (root, k, v) => setIn(root, fnv(k), k, v, 0)

const delIn = (n, h, k, sh) => { // returns the new node, null when the node is now empty, or n when k is absent
  const bit = 1 << ((h >>> sh) & 31)
  if ((n.bm & bit) === 0) return n
  const i = pop(n.bm & (bit - 1))
  const e = n.a[i]
  let ne
  if (e instanceof Leaf) { if (e.k !== k) return n; ne = null }
  else if (e instanceof Coll) {
    const j = e.ks.indexOf(k); if (j < 0) return n
    if (e.ks.length === 2) ne = new Leaf(h, e.ks[1 - j], e.vs[1 - j])
    else { const ks = e.ks.slice(), vs = e.vs.slice(); ks.splice(j, 1); vs.splice(j, 1); ne = new Coll(h, ks, vs) }
  } else { ne = delIn(e, h, k, sh + 5); if (ne === e) return n }
  if (ne === null) {
    if (n.a.length === 1) return null
    const a = n.a.slice(); a.splice(i, 1)
    return new Node(n.bm & ~bit, a)
  }
  const a = n.a.slice(); a[i] = ne
  return new Node(n.bm, a)
}
export const del = (root, k) => { const r = delIn(root, fnv(k), k, 0); return r === null ? EMPTY : r }

export const each = (n, fn) => {
  for (const e of n.a) {
    if (e instanceof Leaf) fn(e.v, e.k)
    else if (e instanceof Coll) for (let j = 0; j < e.ks.length; j++) fn(e.vs[j], e.ks[j])
    else each(e, fn)
  }
}
export const fromMap = (m) => { let r = EMPTY; for (const [k, v] of m) r = set(r, k, v); return r }
