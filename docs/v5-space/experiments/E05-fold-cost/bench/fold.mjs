// E-05 part 1: µs per record to fold fero records into data through fero's seam.
//   node --expose-gc fold.mjs <rows> <views> [mode]   rows: 1000 | 100000 | 1000000; views: none | group | filter100;
//                                                      mode: rec | b256 (default both)
// Two ways to hand records to data:
//   rec   substrate.applyRec(p, r) per record: what fero v4 does today (one lane call, one data commit per record)
//   b256  data's hot lane with 256 records per call, made as substrate.ts makes it: what a v5 kernel handing
//         over a committed batch would do (one data commit per 256 records)
// Four record kinds: field (one field of a row), set (a whole ~100 B row replaced), insert (a new row), delete.
// Records are built before each timed round and the heap is collected, so the time is the fold's own
// (plus the garbage the fold itself makes). Each (mode, kind) first times a probe (64 records for rec, one
// batch of 256 for b256) and sizes its rounds to about 300 ms (at least the probe's size, at most 100,000
// records; 3 rounds instead of 5 when a round would take over a second), so slow views stay inside a minute.
// Views are built after the rows are loaded (data's bulk path). Output: one JSON line per (kind, mode).
import { S, row, key, laneFor, fill, attachViews, gc, now, cpu, median, out, UPDATE, INSERT, REMOVE } from './common.mjs'

const N = +process.argv[2]
const VIEWS = process.argv[3] ?? 'none'
const ROUNDS = +(process.env.ROUNDS ?? 5)
const MMAX = +(process.env.M ?? 100_000) // most records per timed round
const TARGET_US = 300_000 // aim for rounds of about 300 ms
const MODES = process.argv[4] ? [process.argv[4]] : ['rec', 'b256']
const size = (mode, usPer) => Math.max(mode === 'rec' ? 64 : 256, Math.min(MMAX, Math.floor(TARGET_US / Math.max(usPer, 1e-3) / 256) * 256))
const roundsFor = (m, usPer) => (m * usPer > 1e6 ? 3 : ROUNDS)

const p = S.proxy({})
const t0 = now()
fill(p, N)
const fillMs = Number(now() - t0) / 1e6
const subs = attachViews(p, VIEWS)
const lane = laneFor(p)
gc()

let stamp = 1
let fresh = 0
const idx = (i) => (i * 7919) % N

// b256 batches are cut before timing, so b256 times only the lane
const batches = (recs) => { const b = []; for (let i = 0; i < recs.length; i += 256) b.push(recs.slice(i, i + 256)); return b }
const applyB = (mode, recs, bs) => {
  if (mode === 'rec') for (let i = 0; i < recs.length; i++) S.applyRec(p, recs[i])
  else for (let i = 0; i < bs.length; i++) lane(bs[i])
}

const make = {
  field: (m, base) => Array.from({ length: m }, (_, i) => ({ type: UPDATE, key: [key(idx(base + i)), 'n'], value: ++stamp })),
  set: (m, base) => Array.from({ length: m }, (_, i) => { const j = idx(base + i); return { type: UPDATE, key: [key(j)], value: row(j, ++stamp) } }),
}

const timed = (fn) => { gc(); const c0 = cpu(), w0 = now(); fn(); const w = Number(now() - w0) / 1e3, c = cpu() - c0; return { w, c } }

const insDel = (mode, m, rounds) => {
  const c = Math.min(m, N) // insert then delete in chunks of at most N, so the source stays near N rows
  const wi = [], wd = [], ci = [], cd = []
  for (let r = 0; r < rounds; r++) {
    let tiw = 0, tdw = 0, tic = 0, tdc = 0
    for (let done = 0; done < m; done += c) {
      const ks = Array.from({ length: c }, () => 'x' + fresh++)
      const ins = ks.map((k, i) => ({ type: INSERT, key: [], at: k, value: row(i, ++stamp) }))
      const del = ks.map((k) => ({ type: REMOVE, key: [k] }))
      const bi = batches(ins), bd = batches(del)
      const a = timed(() => applyB(mode, ins, bi))
      const b = timed(() => applyB(mode, del, bd))
      tiw += a.w; tic += a.c; tdw += b.w; tdc += b.c
    }
    wi.push(tiw / m); ci.push(tic / m); wd.push(tdw / m); cd.push(tdc / m)
  }
  return { insert: [wi, ci], delete: [wd, cd], chunk: c }
}
const line = (mode, kind, wall, cp, m, extra = {}) => out({ exp: 'E-05', part: 'fold', rows: N, views: VIEWS, mode, kind, us_wall: +median(wall).toFixed(3), us_cpu: +median(cp).toFixed(3), wall_min: +Math.min(...wall).toFixed(3), wall_max: +Math.max(...wall).toFixed(3), per_round: m, rounds: wall.length, fill_ms: Math.round(fillMs), ...extra })

for (const mode of MODES) {
  const P = mode === 'rec' ? 64 : 256
  for (const kind of ['field', 'set']) {
    const probe = make[kind](P, 0), pb = batches(probe)
    const est = timed(() => applyB(mode, probe, pb)).w / P
    const m = size(mode, est), R = roundsFor(m, est)
    const wall = [], cp = []
    for (let r = -1; r < R; r++) {
      const recs = make[kind](m, (r + 1) * m)
      const bs = batches(recs)
      const t = timed(() => applyB(mode, recs, bs))
      if (r >= 0) { wall.push(t.w / m); cp.push(t.c / m) }
    }
    line(mode, kind, wall, cp, m)
  }
  const pr = insDel(mode, P, 1)
  const est = Math.max(median(pr.insert[0]), median(pr.delete[0]))
  const m = size(mode, est)
  const res = insDel(mode, m, roundsFor(m, 2 * est))
  line(mode, 'insert', res.insert[0], res.insert[1], m, { chunk: res.chunk })
  line(mode, 'delete', res.delete[0], res.delete[1], m, { chunk: res.chunk })
}
for (const s of subs) s.dispose()
