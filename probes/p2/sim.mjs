// The Node side of probe P2: the simulator as WASM, with data folding each
// committed batch.
//
// The .wasm is compiled once. One instance is made and used for every seed;
// the world resets inside it. JavaScript gives the module one function,
// `fero.batch`. The module calls it once per batch of committed entries of one
// replica. Messages between the simulated servers never come here.
//
// A fold is one data value. There is one per replica per group: 3 servers
// times 2 groups, so 6. A replica that restarts applies its log again from
// the first index; its fold then starts again from nothing, as a server's
// memory does.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))

export const SERVERS = 3
export const GROUPS = 2
const OP_SET = 0, OP_INCR = 1, OP_DEL = 2

/** Where the data checkout is: DATA_DIR, or `data` next to this repo. */
export const dataDir = () => process.env.DATA_DIR ?? join(here, '..', '..', '..', 'data')

/** Loads data's one entry file. */
export const loadData = (dir = dataDir()) => import(join(dir, 'api', 'index.ts'))

/** Compiles the module. Done once per process. */
export const compile = (path) => new WebAssembly.Module(readFileSync(path))

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0')
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Makes one instance and returns the calls a runner needs.
 * `D` is data's module, or null to fold nothing (the hook then returns at once).
 */
export function open(mod, D) {
  let memory, mem, dv
  const folds = []
  const recs = []
  const stats = { batches: 0, entries: 0, writes: 0, refolds: 0, foldPairsCompared: 0 }

  // A grown memory detaches the old buffer; a view of a detached buffer has length 0.
  const view = () => {
    if (!mem || mem.length === 0) { mem = new Uint8Array(memory.buffer); dv = new DataView(memory.buffer) }
    return mem
  }
  const newFold = (i) => {
    const src = D.$({})
    folds[i] = { src, lane: D.lane(src, { onReject: (r) => { throw r.error } }), applied: 0 }
  }
  const newFolds = () => { if (D) for (let i = 0; i < SERVERS * GROUPS; i++) newFold(i) }

  // The hook. `first` is the log index of the batch's first entry; it crosses as two halves.
  const batch = (server, group, firstLo, firstHi, ptr, len) => {
    stats.batches++
    if (!D) return
    const first = (firstHi >>> 0) * 4294967296 + (firstLo >>> 0)
    const slot = server * GROUPS + group
    let f = folds[slot]
    if (first <= f.applied) { newFold(slot); f = folds[slot]; stats.refolds++ }
    if (first !== f.applied + 1) throw new Error(`server ${server} group ${group}: batch starts at ${first} after ${f.applied}`)
    const b = view()
    const end = ptr + len
    let pos = ptr, count = 0
    const varint = () => {
      let v = 0, m = 1
      for (;;) { const x = b[pos++]; v += (x & 127) * m; if (x < 128) return v; m *= 128 }
    }
    const flush = () => { if (recs.length) { f.lane(recs); recs.length = 0 } }
    while (pos < end) {
      const n = varint()
      const next = pos + n
      count++
      if (n > 0) {
        const op = b[pos++]
        varint() // the request id: decoded, not used by the fold
        const klen = varint()
        const key = utf8.decode(b.subarray(pos, pos + klen))
        pos += klen
        if (op === OP_SET) {
          recs.push({ type: 0, key: [key], value: dv.getFloat64(pos, true) })
        } else if (op === OP_INCR) {
          const v = dv.getFloat64(pos, true)
          flush()
          recs.push({ type: 0, key: [key], value: (f.src[D.value][key] ?? 0) + v })
        } else if (op === OP_DEL) {
          flush()
          if (key in f.src[D.value]) recs.push({ type: 2, key: [key] })
        } else throw new Error('unknown op ' + op)
        stats.writes++
      }
      pos = next
    }
    flush()
    f.applied = first + count - 1
    stats.entries += count
  }

  const ex = new WebAssembly.Instance(mod, { fero: { batch } }).exports
  memory = ex.memory

  // A monitor that fails panics inside the module; the call traps. The module keeps the message.
  const call = (fn, seed) => {
    try {
      return fn(seed % 4294967296, Math.floor(seed / 4294967296))
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e
      mem = undefined
      const p = ex.p2_panic_ptr(), n = ex.p2_panic_len()
      throw new Error(`seed ${seed}: the simulator stopped: ${new TextDecoder().decode(view().subarray(p, p + n))}`)
    }
  }
  const hash = () => hex8(ex.p2_hash_hi()) + hex8(ex.p2_hash_lo())

  // Replicas of one group at the same applied index must hold the same data value.
  const checkFolds = (seed) => {
    for (let g = 0; g < GROUPS; g++) {
      const byApplied = new Map()
      for (let s = 0; s < SERVERS; s++) {
        const f = folds[s * GROUPS + g]
        const now = JSON.stringify(f.src[D.value])
        const seen = byApplied.get(f.applied)
        if (seen === undefined) byApplied.set(f.applied, now)
        else if (++stats.foldPairsCompared, seen !== now) throw new Error(`seed ${seed}: group ${g}: two replicas at applied ${f.applied} fold to different values`)
      }
    }
  }

  return {
    stats,
    memoryBytes: () => memory.buffer.byteLength,
    /** One seed whole: 130 ticks of chaos. Returns the events and the trace hash. */
    runSeed(seed) {
      newFolds()
      const events = call(ex.p2_run_seed, seed)
      if (D) checkFolds(seed)
      return { events, hash: hash() }
    },
    /** A fresh world, a leader in both groups, three writes, one read, destroy. */
    fresh(seed) {
      newFolds()
      const events = call(ex.p2_fresh, seed)
      if (D) {
        for (let s = 0; s < SERVERS; s++) {
          const row = folds[s * GROUPS].src[D.value]
          if (row.stock !== 9 || row.name !== 3) throw new Error(`fresh world, server ${s}: read ${JSON.stringify(row)}`)
        }
      }
      ex.p2_destroy()
      folds.length = 0
      return { events, hash: hash() }
    },
    /** The folded value of one replica, for a test. */
    value: (server, group) => folds[server * GROUPS + group].src[D.value],
    applied: (server, group) => folds[server * GROUPS + group].applied,
  }
}
