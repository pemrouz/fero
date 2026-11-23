// E-65 X2: the seeded run. Each seed builds a world, writes for a while, then scans every row while writes,
// three-step slot moves, copy failures and lagging copies go on; the oracle then checks what the scan handed on.
//
//   node src/sim.mjs --mode=none|slot|cut --seeds=1000 [--G=4 --S=64 --keys=800 --P=4 --moveP=0.02 --failP=0.01]
//                    [--bug=<name>] [--from=1] [--out=results/sim.jsonl] [--tag=...]
//
// The oracle shares no code with the copies or the scanner. It reads the world's truth: every key's history by
// slot position and by step, and every commit that touched two or more slots.
//   'none': every key handed on at most once; every key that existed for the whole scan handed on exactly once;
//           each row handed on is one the key had at some step of the scan (by identity, so a stale row fails).
//   'slot', 'cut': each slot handed on exactly once, as exactly its rows at the position the scanner reports for
//           it (equal as values, no key missing or extra); that position is at or past the slot's position when
//           the scan began. 'cut' also: no commit is torn (shown in some of its slots and not in others).
//           'slot' counts torn commits as a measure: it promises a cut per slot only.
import { World } from './world.mjs'
import { Scan } from './scan.mjs'
import { canon, out, args } from './lib.mjs'

const o = args(process.argv.slice(2), { mode: 'none', seeds: 200, from: 1, G: 4, S: 64, C: 3, keys: 800, P: 4, moveP: 0.02, failP: 0.01, lagMax: 25, multi: 0.2, wps: 2, moveLen: 15, warm: 300, cap: 20000, pinSpread: 8, bug: '', out: '', tag: '', quiet: false })
const bugs = {}
for (const b of String(o.bug || '').split(',').filter(Boolean)) bugs[b] = true

function oracle(w, sc) {
  const bad = []
  let checks = 0, torn = 0, multi = 0
  if (sc.mode === 'none') {
    for (const [k, rows] of sc.deliv) {
      checks++
      if (rows.length > 1) { bad.push(['twice', k, rows.length]); continue }
      const row = rows[0]
      const ok = row !== undefined && (w.rowAtStep(k, sc.T0) === row || (w.histT.get(k) ?? []).some(([t, r]) => t > sc.T0 && t <= sc.T1 && r === row))
      if (!ok) bad.push(['not-current', k])
    }
    for (let i = 0; i < w.nkeys; i++) {
      const k = w.keyName[i]
      if (w.rowAtStep(k, sc.T0) === undefined) continue
      const gone = (w.histT.get(k) ?? []).some(([t, r]) => t > sc.T0 && t <= sc.T1 && r === undefined)
      if (gone) continue
      checks++
      if (!sc.deliv.has(k)) bad.push(['missed', k])
    }
    return { bad, checks, torn, multi }
  }
  const pos = new Int32Array(w.S).fill(-1)
  for (let s = 0; s < w.S; s++) {
    checks++
    const d = sc.deliv.get(s) ?? []
    if (d.length !== 1) { bad.push(['slot-handed', s, d.length]); continue }
    const { rows, pos: p, dup } = d[0]
    if (dup) bad.push(['dup-in-slot', s, dup])
    pos[s] = p
    if (p < sc.spos0[s]) bad.push(['below-start', s, p, sc.spos0[s]])
    const want = new Map()
    for (let i = 0; i < w.nkeys; i++) if (w.slotOfKey[i] === s) { const k = w.keyName[i]; const r = w.rowAtPos(k, p); if (r !== undefined) want.set(k, r) }
    if (want.size !== rows.size) bad.push(['count', s, want.size, rows.size])
    for (const [k, r] of want) { checks++; if (canon(rows.get(k)) !== canon(r)) { bad.push(['row', s, k]); break } }
  }
  for (const e of w.multiSlot) {
    const vis = e.slots.map(([s, p]) => pos[s] >= 0 && p <= pos[s])
    if (vis.some((x) => x) && vis.some((x) => !x)) { torn++; if (sc.mode === 'cut') bad.push(['torn', e.g, e.idx]) }
    if (vis.some((x) => x)) multi++
  }
  return { bad, checks, torn, multi }
}

let failed = 0, checks = 0, torn = 0, multi = 0
const tot = { pages: 0, waits: 0, failovers: 0, moved: 0, restarts: 0, pinsTaken: 0, repins: 0, rounds: 0, maxImages: 0, rows: 0, errs: 0, moves: 0, fails: 0, steps: 0, unfinished: 0 }
const firstBad = []
const t0 = Date.now()
for (let seed = o.from; seed < o.from + o.seeds; seed++) {
  const w = new World({ seed, G: o.G, S: o.S, C: o.C, keys: o.keys, multi: o.multi, moveP: o.moveP, failP: o.failP, lagMax: o.lagMax, wps: o.wps, moveLen: o.moveLen, bugs })
  for (let i = 0; i < o.warm; i++) w.tick()
  const sc = new Scan(w, { mode: o.mode, P: o.P, bugs, id: seed, pinSpread: o.pinSpread })
  sc.start()
  const m0 = w.st.moves, f0 = w.st.fails, s0 = w.step
  let n = 0
  while (!sc.done && n++ < o.cap) { w.tick(); sc.tick() }
  if (!sc.done) { tot.unfinished++; failed++; if (firstBad.length < 5) firstBad.push([seed, 'unfinished']); continue }
  const r = oracle(w, sc)
  checks += r.checks; torn += r.torn; multi += r.multi
  for (const k of Object.keys(sc.st)) tot[k] = k === 'maxImages' ? Math.max(tot[k], sc.st[k]) : tot[k] + sc.st[k]
  tot.moves += w.st.moves - m0; tot.fails += w.st.fails - f0; tot.steps += w.step - s0
  if (r.bad.length) { failed++; if (firstBad.length < 5) firstBad.push([seed, ...r.bad[0]]) }
}
out(o.out, { kind: 'sim', tag: o.tag, mode: o.mode, bug: o.bug || 'none', G: o.G, S: o.S, C: o.C, keys: o.keys, P: o.P, moveP: o.moveP, failP: o.failP, lagMax: o.lagMax, wps: o.wps, moveLen: o.moveLen, pinSpread: o.pinSpread, seeds: o.seeds, from: o.from, failed, checks, tornCommits: torn, multiSlotCommitsSeen: multi, ...tot, firstBad, sec: (Date.now() - t0) / 1000 })
