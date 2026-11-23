// E-65 X1: seeded runs with an oracle, on data's real engine (DATA, read only).
//
//   node sim.mjs --part=split --form=blocks|groups|one [--S=8] [--G=4] [--seeds=1000] [--steps=1500]
//                [--dom=int|float] [--mutate=...]
//     The asker holds every row of a resource whose slots G groups own. Each group's records reach it in that
//     group's order, interleaved with other groups' at random; slots move between groups; a group that
//     reconnects sends its last 1 to 20 frames again. The asker keeps the rows in S data sources by block of
//     slots (blocks), one source per group (groups), or one source (one, today's R0). Its rules:
//       B1  a slot's records are applied in that slot's order: one past the next is held until its turn
//       B2  a record at or below the slot's place is dropped (a resend)
//       B3  a read over every row crosses the sources: get routes by the same block function the fold uses; a
//           count and a sum add the sources' views; a top k takes each source's top k and keeps the best k; a
//           median comes from one sorted column fed by every source's row deltas
//       B4  (groups only) a slot that moved: its rows move to the new group's source when the move reaches the
//           asker, before the new group's first record of that slot is applied
//     Planted (--mutate): noorder (B1 off), nodup (B2 off), route (B3: get picks the block another way),
//     topshort (B3: each source gives k/2 to the top k), medmed (B3: median of the sources' medians),
//     nomigrate (B4 off).
//     The oracle: the true rows at the asker's cut (each slot's records up to the asker's place for it, in
//     order, applied to a plain Map by code here). Every 25 steps: the row count, 20 gets, the sum of cents,
//     the top 10 scores, the median score. Every 250 steps and at the end: every row.
//     --dom=float makes cents decimals: then the sums are compared, but only counted, never failed (a finding).
//
//   node sim.mjs --part=compact --form=arena|column|kvdisk [--seeds=1000] [--steps=600] [--mutate=...]
//     The off-heap stores of compact.mjs against a plain Map, on a dirty domain: numbers as strings, null,
//     objects and arrays in fields, unknown fields, booleans, emoji in keys and text (no NaN and no -0: the
//     arena keeps rows as JSON, which loses both). After every batch the touched keys and the count; every 100
//     steps every row and the sum of the numeric cents.
//     Planted: tombstop (a probe stops at a tombstone), compactaddr (arena: compaction forgets an address),
//     presence (column: a deleted field keeps its presence bit), nooverflow (column: a value of the wrong type
//     is forced into its column).
import { rng, slotOf, SLOTS, args, out, loadData, loadavg } from './lib.mjs'
import { useData, OneStore, BlockStores, GroupStores } from './dstores.mjs'
import { ArenaStore, ColumnStore, setChunk } from './compact.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const A = args()
const part = A.part ?? 'split', form = A.form ?? 'blocks', seeds = A.seeds ?? 1000, mutate = A.mutate ?? ''
const first = A.first ?? 1

function canon(v) {
  if (v === undefined) return 'u'
  if (v === null) return 'n'
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'T' : 'F'
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const ks = Object.keys(v).sort()
  return '{' + ks.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}
function oApply(m, r) { // the oracle's fold: a plain Map, written apart from data and from compact.mjs
  if (r.type === 1) { m.set(r.at, r.value); return }
  const k = r.key[0]
  if (r.key.length === 1) { if (r.type === 0) m.set(k, r.value); else m.delete(k); return }
  const row = m.get(k)
  if (row === undefined) return
  const n = { ...row }
  if (r.type === 0) n[r.key[1]] = r.value; else delete n[r.key[1]]
  m.set(k, n)
}
const hot = (s) => (s & 15) === ((s >> 4) & 15)
const medianOf = (xs) => { if (!xs.length) return undefined; xs.sort((a, b) => a - b); const h = (xs.length - 1) * 0.5, lo = Math.floor(h); return h === lo ? xs[lo] : xs[lo] + (h - lo) * (xs[lo + 1] - xs[lo]) }

// ── split: the asker's sources, fed by G groups ──────────────────────────────────────────────────────────
async function splitSeed(seed, D) {
  const r = rng(seed), G = A.G ?? 4, S = A.S ?? 8, steps = A.steps ?? 2000, K = A.keys ?? 600, dom = A.dom ?? 'int'
  const users = 40
  const genRow = () => ({ user: 'u' + Math.floor(r() * users), cents: dom === 'float' ? Math.floor(r() * 1e6) / 100 : Math.floor(r() * 10000), score: Math.floor(r() * 1000), paid: r() < 0.5, title: 't' + Math.floor(r() * 1e6) })
  // slots to groups: contiguous ranges at the start; moves change it
  const owner = new Int16Array(SLOTS); for (let s = 0; s < SLOTS; s++) owner[s] = Math.floor((s * G) / SLOTS)
  const logs = Array.from({ length: G }, () => []), next = new Int32Array(G)
  const seq = new Int32Array(SLOTS), slotRecs = Array.from({ length: SLOTS }, () => [])
  const head = new Map() // the generator's head rows (to write valid records)
  // the asker
  const store = form === 'one' ? new OneStore() : form === 'groups' ? new GroupStores(G, { mutate }) : new BlockStores(S, { mutate })
  if (form !== 'groups') store.views({ k: 10 })
  const pos = new Int32Array(SLOTS), held = new Map() // slot -> Map(seq -> { g, rec })
  const truth = new Map(), tpos = new Int32Array(SLOTS)
  const st = { moves: 0, held: 0, dups: 0, checks: 0, resends: 0, stalls: 0, floatSumOff: 0, floatSumChecks: 0 }
  const stall = new Int32Array(G)
  const advanceTruth = (s) => { const rs = slotRecs[s]; while (tpos[s] < pos[s]) oApply(truth, rs[tpos[s]++]) }
  let batch = [], bgroup = []
  const take = (g, rec, s, q) => { batch.push(rec); bgroup.push(g); pos[s] = mutate === 'noorder' ? Math.max(pos[s], q) : q }
  const flush = () => {
    if (!batch.length) return
    if (form === 'groups') { for (let i = 0; i < batch.length; i++) store.applyFrom(bgroup[i], [batch[i]]) }
    else store.apply(batch)
    batch = []; bgroup = []
  }
  const receive = (g, frame) => {
    for (const { s, q, rec } of frame) {
      if (q <= pos[s] && mutate !== 'nodup') { st.dups++; continue } // B2
      if (q === pos[s] + 1 || mutate === 'noorder' || (mutate === 'nodup' && q <= pos[s])) {
        take(g, rec, s, q)
        const h = held.get(s)
        while (h && h.has(pos[s] + 1)) { const x = h.get(pos[s] + 1); h.delete(pos[s] + 1); take(x.g, x.rec, s, pos[s] + 1) }
      } else { let h = held.get(s); if (!h) held.set(s, (h = new Map())); h.set(q, { g, rec }); st.held++ } // B1
    }
    flush()
  }
  // keys live in 256 'hot' slots, a few keys each, so moves and reordering meet written rows; the hot slots
  // spread over every block and every group's range (slot = 16a + b with b = a mod 16)
  const keys = []; for (let i = 0; keys.length < K; i++) if (hot(slotOf('k' + i))) keys.push('k' + i)
  const keyOfG = (g) => { for (let t = 0; t < 50; t++) { const k = keys[Math.floor(r() * K)]; if (owner[slotOf(k)] === g) return k } return null }
  const gen = (k) => {
    const row = head.get(k)
    let rec
    if (row === undefined) rec = { type: 1, key: [], at: k, value: genRow() }
    else {
      const u = r()
      if (u < 0.2) rec = { type: 0, key: [k], value: genRow() }
      else if (u < 0.45) rec = { type: 0, key: [k, 'cents'], value: dom === 'float' ? Math.floor(r() * 1e6) / 100 : Math.floor(r() * 10000) }
      else if (u < 0.65) rec = { type: 0, key: [k, 'score'], value: Math.floor(r() * 1000) }
      else if (u < 0.75) rec = { type: 0, key: [k, 'user'], value: 'u' + Math.floor(r() * users) }
      else if (u < 0.82) rec = { type: 2, key: [k, 'score'] }
      else if (u < 0.88) rec = { type: 2, key: [k, 'cents'] }
      else rec = { type: 2, key: [k] }
    }
    oApply(head, rec)
    const s = slotOf(k)
    const x = { s, q: ++seq[s], rec }
    slotRecs[s].push(rec)
    return x
  }
  const check = (full) => {
    st.checks++
    for (let s = 0; s < SLOTS; s++) if (tpos[s] < pos[s]) advanceTruth(s)
    const fail = (what) => { throw new Error(what) }
    if (store.count() !== truth.size) fail(`count ${store.count()} vs ${truth.size}`)
    for (let i = 0; i < 20; i++) { const k = keys[Math.floor(r() * K)]; if (canon(store.get(k)) !== canon(truth.get(k))) fail(`get ${k}: ${canon(store.get(k))} vs ${canon(truth.get(k))}`) }
    const cents = [], scores = []
    for (const row of truth.values()) { if (typeof row.cents === 'number') cents.push(row.cents); if (typeof row.score === 'number') scores.push(row.score) }
    if (form !== 'groups') {
      const v = store.read()
      if (v.len !== truth.size) fail(`length view ${v.len} vs ${truth.size}`)
      if (dom === 'int') { const tsum = cents.reduce((a, b) => a + b, 0); if (v.sum !== tsum) fail(`sum ${v.sum} vs ${tsum}`) }
      else { // exact: cents are hundredths
        st.floatSumChecks++
        const exact = cents.reduce((a, b) => a + BigInt(Math.round(b * 100)), 0n)
        if (v.sum !== Number(exact) / 100) st.floatSumOff++ // the exact sum, rounded once
      }
      const top = [...scores].sort((a, b) => b - a).slice(0, 10)
      if (canon(v.top) !== canon(top)) fail(`top ${canon(v.top)} vs ${canon(top)}`)
      const m = medianOf(scores)
      if (canon(v.med) !== canon(m)) fail(`median ${v.med} vs ${m}`)
    }
    if (full) {
      const seen = new Map()
      store.each((k, row) => { if (seen.has(k)) fail(`row ${k} twice`); seen.set(k, row) })
      if (seen.size !== truth.size) fail(`every row: ${seen.size} vs ${truth.size}`)
      for (const [k, row] of truth) if (canon(seen.get(k)) !== canon(row)) fail(`row ${k} differs`)
    }
  }
  try {
    for (let step = 1; step <= steps; step++) {
      const u = r()
      if (u < 1 / 150 && G > 1) { // a slot move: a run of 1 to 16 of A's slots goes to B
        const a = Math.floor(r() * G), b = (a + 1 + Math.floor(r() * (G - 1))) % G
        const mine = []; for (let s = 0; s < SLOTS; s++) if (hot(s) && owner[s] === a) mine.push(s)
        if (mine.length > 1) { const n = 1 + Math.floor(r() * Math.min(16, mine.length - 1)), at = Math.floor(r() * (mine.length - n)); for (let i = at; i < at + n; i++) owner[mine[i]] = b; st.moves++ }
      } else if (u < 0.6) { // a commit at one group: 1 record, or 2 to 4 (5 %)
        const g = Math.floor(r() * G), n = r() < 0.05 ? 2 + Math.floor(r() * 3) : 1, frame = []
        for (let i = 0; i < n; i++) { const k = keyOfG(g); if (k) frame.push(gen(k)) }
        if (frame.length) logs[g].push(frame)
      }
      if (r() < 1 / 150) { const g = Math.floor(r() * G); const back = Math.min(next[g], 1 + Math.floor(r() * 20)); next[g] -= back; st.resends += back } // a reconnect sends the last 1 to 20 frames again
      if (r() < 1 / 100) { const g = Math.floor(r() * G); stall[g] = step + 20 + Math.floor(r() * 280); st.stalls++ } // a slow link: nothing from g for a while
      const d = Math.floor(r() * 4)
      for (let i = 0; i < d; i++) { const g = Math.floor(r() * G); if (stall[g] < step && next[g] < logs[g].length) receive(g, logs[g][next[g]++]) }
      if (step % 25 === 0) check(step % 250 === 0)
    }
    for (let g = 0; g < G; g++) while (next[g] < logs[g].length) receive(g, logs[g][next[g]++]) // drain
    check(true)
    return { ok: true, st, moved_rows: store.moved ?? 0 }
  } catch (e) { return { ok: false, st, err: String(e?.message ?? e).slice(0, 160) } }
}

// ── compact: off-heap stores against a plain Map, on a dirty domain ─────────────────────────────────────
function compactSeed(seed, dir) {
  const r = rng(seed), steps = A.steps ?? 600, K = A.keys ?? 600
  const keys = Array.from({ length: K }, (_, i) => (i % 37 === 5 ? 'ключ' + i : i % 41 === 7 ? 'k🙂' + i : 'k' + i))
  const odd = () => { const u = r(); return u < 0.2 ? String(Math.floor(r() * 100)) : u < 0.35 ? null : u < 0.5 ? { a: Math.floor(r() * 9) } : u < 0.6 ? [1, 'x'] : u < 0.75 ? r() < 0.5 : 'x🙂' }
  const val = (f) => {
    if (r() < 0.06) return odd()
    if (f === 'user' || f === 'sku') return f + Math.floor(r() * 30)
    if (f === 'title') return r() < 0.1 ? 'тайтл ✓ ' + Math.floor(r() * 1e4) : 'title ' + Math.floor(r() * 1e9).toString(36)
    if (f === 'paid') return r() < 0.5
    return r() < 0.5 ? Math.floor(r() * 1e4) : Math.floor(r() * 1e6) / 100
  }
  const FS = ['user', 'cents', 'score', 'paid', 'sku', 'title', 'at', 'qty']
  const genRow = () => { const o = {}; for (const f of FS) if (r() < 0.9) o[f] = val(f); if (r() < 0.05) o.extra = val('cents'); return o }
  const head = new Map()
  const store = form === 'arena' ? new ArenaStore({ mutate }) : form === 'kvdisk' ? new ArenaStore({ mutate, file: join(dir, 'kv-' + seed) }) : new ColumnStore({ mutate })
  const truth = new Map()
  let checks = 0
  try {
    for (let step = 1; step <= steps; step++) {
      const n = 1 + Math.floor(r() * 30), recs = [], touched = new Set()
      for (let i = 0; i < n; i++) {
        const k = keys[Math.floor(r() * K)], row = head.get(k)
        let rec
        if (row === undefined) rec = { type: 1, key: [], at: k, value: genRow() }
        else {
          const u = r(), f = r() < 0.05 ? 'extra' : FS[Math.floor(r() * FS.length)]
          if (u < 0.2) rec = { type: 0, key: [k], value: genRow() }
          else if (u < 0.75) rec = { type: 0, key: [k, f], value: val(f) }
          else if (u < 0.88) rec = { type: 2, key: [k, f] }
          else rec = { type: 2, key: [k] }
        }
        oApply(head, rec); recs.push(rec); touched.add(rec.type === 1 ? rec.at : rec.key[0])
      }
      store.apply(recs)
      for (const x of recs) oApply(truth, x)
      checks++
      for (const k of touched) if (canon(store.get(k)) !== canon(truth.get(k))) throw new Error(`get ${k}: ${canon(store.get(k))} vs ${canon(truth.get(k))}`)
      if (store.count() !== truth.size) throw new Error(`count ${store.count()} vs ${truth.size}`)
      if (step % 100 === 0 || step === steps) {
        const seen = new Map(); store.each((k, row) => seen.set(k, row))
        if (seen.size !== truth.size) throw new Error(`every row ${seen.size} vs ${truth.size}`)
        for (const [k, row] of truth) if (canon(seen.get(k)) !== canon(row)) throw new Error(`row ${k}: ${canon(seen.get(k))} vs ${canon(row)}`)
        let a = 0, b = 0
        store.field('cents', (v) => { if (typeof v === 'number') a += v })
        for (const row of truth.values()) if (typeof row.cents === 'number') b += row.cents
        if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) throw new Error(`sum ${a} vs ${b}`)
      }
    }
    store.close?.()
    return { ok: true, checks, compactions: store.compactions ?? 0, overflow: store.over?.size ?? 0 }
  } catch (e) { store.close?.(); return { ok: false, checks, err: String(e?.message ?? e).slice(0, 160) } }
}

const t0 = Date.now()
let failed = 0, firstErr = null, tot = {}
if (part === 'split') {
  const D = await loadData(); useData(D)
  for (let s = first; s < first + seeds; s++) {
    const res = await splitSeed(s, D)
    if (!res.ok) { failed++; firstErr ??= { seed: s, err: res.err } }
    for (const [k, v] of Object.entries(res.st)) tot[k] = (tot[k] ?? 0) + v
    tot.moved_rows = (tot.moved_rows ?? 0) + (res.moved_rows ?? 0)
  }
} else {
  setChunk(A.chunk ?? 4096)
  const dir = mkdtempSync(join(tmpdir(), 'e65-x1-'))
  for (let s = first; s < first + seeds; s++) {
    const res = compactSeed(s, dir)
    if (!res.ok) { failed++; firstErr ??= { seed: s, err: res.err } }
    tot.checks = (tot.checks ?? 0) + res.checks; tot.compactions = (tot.compactions ?? 0) + (res.compactions ?? 0); tot.overflow_rows_at_end = (tot.overflow_rows_at_end ?? 0) + (res.overflow ?? 0)
  }
  rmSync(dir, { recursive: true, force: true })
}
out({ exp: 'E-65', opt: 'X1', bench: 'sim', part, form, S: part === 'split' && form === 'blocks' ? (A.S ?? 8) : undefined, G: part === 'split' ? (A.G ?? 4) : undefined, dom: A.dom ?? (part === 'split' ? 'int' : 'dirty'), mutate: mutate || 'none', seeds, steps: A.steps ?? (part === 'split' ? 2000 : 600), failed, ...tot, first_fail: firstErr, seconds: (Date.now() - t0) / 1000, node: process.version, loadavg_end: loadavg() })
