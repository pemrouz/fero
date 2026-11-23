// E-65 X3, the cost bench. One part per process; run.sh runs each part alone under the timing lock, three runs.
// Inside a run: a warm-up, then the median of 5 rounds.
//   partial  the partial's work per write on a group copy: N rows over G groups and 4,096 slots (so N / 4,096 rows
//            a slot), each lawful fold; a write replaces a random row with a new one. For the folds with no inverse,
//            three forms: the default (slot pieces in blocks of 32 slots, and the author's 'keeps' hint), 'nokeeps'
//            (every leaving row rescans its slot) and 'flat' (the group's piece folds every slot again).
//   merger   the merger's work per write: G groups' partials make real frames, then the merger alone takes them, in
//            frames of B writes (the partial folds B writes into one frame first).
//   check    fero's self-check at build (200 trials over 64 real rows), and the audit (the group's pieces worked out
//            again from its rows) at N / G rows.
//   node src/bench.mjs --part=partial|merger|check --run=1 [--out=results/bench.jsonl] [--quick]
import { rng, makeRow, keyName, canon } from './lib.mjs'
import { UPartial, UMerger, selfCheck, copy } from './fold.mjs'
import { makeFolds } from './folds.mjs'
import { appendFileSync } from 'node:fs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const PART = arg('part', 'partial'), RUN = +arg('run', '1'), OUT = arg('out', ''), QUICK = process.argv.includes('--quick')
const out = (o) => { const line = JSON.stringify({ part: PART, run: RUN, quick: QUICK, ...o }); console.log(line); if (OUT) appendFileSync(OUT, line + '\n') }
const now = () => Number(process.hrtime.bigint()) / 1e6 // ms
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const h32 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return h >>> 0 }
const ROUNDS = 5

function groupRows(n, seed) {
  const R = rng(seed), rows = []
  for (let i = 0; i < n; i++) { const k = keyName(i); rows.push([k, makeRow(k, 'dirty', R)]) }
  return rows
}

if (PART === 'partial') {
  const cells = QUICK ? [[1e5, 4]] : [[1e5, 4], [1e5, 16], [1e6, 4], [1e6, 16]]
  for (const [N, G] of cells) {
    const per = N / G, gslots = 4096 / G, slotOf = (k) => h32(k) % gslots // the group owns 4096 / G slots
    const rows = groupRows(per, 7), keys = rows.map((r) => r[0])
    for (const F of makeFolds(1)) {
      const forms = F.inv ? ['default'] : ['default', 'nokeeps', 'flat']
      for (const form of forms) {
        const p = new UPartial(0, F, { slotOf, flat: form === 'flat', nokeeps: form === 'nokeeps' })
        const tb = now(); p.takeRows(rows); const buildMs = now() - tb
        const R = rng(11)
        const W = form === 'flat' ? (QUICK ? 200 : 1000) : (QUICK ? 2000 : 10000)
        const round = () => {
          const ch = []
          for (let i = 0; i < W; i++) { const k = keys[Math.floor(R() * keys.length)]; ch.push({ k, next: makeRow(k, 'dirty', R) }) }
          const r0 = p.rescanRows, f0 = p.combines
          let parts = 0
          const t0 = now()
          for (const c of ch) { const fr = p.apply([{ k: c.k, prev: p.rows.get(c.k), next: c.next }]); parts += fr.inv.length + fr.set.length }
          return { ms: now() - t0, rescanRows: (p.rescanRows - r0) / W, combines: (p.combines - f0) / W, parts: parts / W }
        }
        round()
        const rs = Array.from({ length: ROUNDS }, round)
        out({ N, G, fold: F.name, cls: F.inv ? 'inv' : 'mon', form, rowsPerSlot: N / 4096, buildMs: +buildMs.toFixed(1),
          nsPerWrite: +((med(rs.map((r) => r.ms)) * 1e6) / W).toFixed(0), rescanRowsPerWrite: +med(rs.map((r) => r.rescanRows)).toFixed(2),
          combinesPerWrite: +med(rs.map((r) => r.combines)).toFixed(1), framePartsPerWrite: +med(rs.map((r) => r.parts)).toFixed(3) })
      }
    }
  }
}

if (PART === 'merger') {
  const Gs = QUICK ? [4, 64] : [4, 16, 64, 256], Bs = [1, 16, 256]
  const PER = 2000, W = QUICK ? 4096 : 16384
  for (const G of Gs) for (const F of makeFolds(1)) for (const B of Bs) {
    const R = rng(13 + G)
    const ps = [], keys = []
    for (let g = 0; g < G; g++) { const p = new UPartial(g, F); const rows = groupRows(PER, 100 + g).map(([k, r]) => [g + ':' + k, { ...r, id: g + ':' + k }]); p.takeRows(rows); ps.push(p); keys.push(rows.map((r) => r[0])) }
    const pics = ps.map((p) => copy(p.state))
    // the frames: W writes spread over the groups, B writes to a frame
    const frames = []
    for (let i = 0; i < W; i += B) {
      const g = Math.floor(R() * G), p = ps[g], ch = []
      for (let j = 0; j < B; j++) { const k = keys[g][Math.floor(R() * PER)]; ch.push({ k, prev: p.rows.get(k), next: { ...makeRow(k, 'dirty', R), id: k } }); p.rows.set(k, ch[ch.length - 1].next) }
      for (const c of ch) p.rows.set(c.k, c.prev) // apply runs the changes in order
      // a key may repeat inside a frame: chain each change's prev to the one before it
      const seen = new Map(); for (const c of ch) { if (seen.has(c.k)) c.prev = seen.get(c.k); seen.set(c.k, c.next) }
      frames.push([g, copy(p.apply(ch))])
    }
    const round = () => {
      const m = new UMerger(F)
      for (let g = 0; g < G; g++) m.install(g, copy(pics[g]))
      m.settle()
      const fr = frames.map(([g, f]) => [g, copy(f)])
      const t0 = now()
      for (const [g, f] of fr) { m.apply(g, f); m.settle() } // one client frame per partial frame
      return now() - t0
    }
    round()
    const ms = med(Array.from({ length: ROUNDS }, round))
    const parts = frames.reduce((s, [, f]) => s + f.inv.length + f.set.length, 0)
    out({ G, B, fold: F.name, cls: F.inv ? 'inv' : 'mon', frames: frames.length, nsPerFrame: +((ms * 1e6) / frames.length).toFixed(0),
      nsPerWrite: +((ms * 1e6) / W).toFixed(1), partsPerWrite: +(parts / W).toFixed(3), writesPerSec: Math.round(W / (ms / 1000)) })
  }
}

if (PART === 'check') {
  const cells = QUICK ? [25000] : [25000, 250000]
  for (const F of makeFolds(1)) {
    const rows = new Map(groupRows(2000, 5))
    const ts = []
    for (let i = 0; i < ROUNDS + 1; i++) { const t0 = now(); const r = selfCheck(F, rows, rng(i + 1)); ts.push(now() - t0); if (r) throw new Error('lawful fold flagged: ' + F.name + ' ' + r) }
    ts.shift()
    out({ what: 'selfcheck', fold: F.name, msPerCheck: +med(ts).toFixed(3) })
    for (const per of cells) {
      const p = new UPartial(0, F, { slotOf: (k) => h32(k) % 1024 })
      p.takeRows(groupRows(per, 9))
      const as = []
      for (let i = 0; i < ROUNDS + 1; i++) { const t0 = now(); if (!p.audit()) throw new Error('audit failed on a lawful fold'); as.push(now() - t0) }
      as.shift()
      out({ what: 'audit', fold: F.name, rows: per, msPerAudit: +med(as).toFixed(1), nsPerRow: +((med(as) * 1e6) / per).toFixed(0) })
    }
  }
}
