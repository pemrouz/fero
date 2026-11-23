// E-65 X3, the seeded run: user folds kept by partials per group and a merger per view, through slot moves,
// partial resyncs, outages, merger rebuilds and a rolling deploy of new fold code. The world is E-64 O1's
// (sim/sim.mjs there): 1,024 slots, G groups (4, 16, or elastic 1 to 16), E-23's dirty rows, multi-row commits,
// a slot move as ONE paired delivery in both groups' queues, a merger that lags by a random walk.
// New here:
//   folds     six lawful user folds (src/folds.mjs) of both classes, or one fold with an author's mistake (--bug)
//   deploy    (--deploy) a rolling deploy of code version 2. Each group gets a version-2 partial at a random step
//             (its first copy with the new code; built from its rows) and loses its version-1 partial at a random
//             step after that (its last copy with the old code is gone; --overlap=0 is one copy a group, so both
//             happen at once). A group whose version-1 partial is gone puts a MARKER in its queue: the version-1
//             merger cannot pass it, so the live view stops moving for that group. Once every group has a
//             version-2 partial, version-2 mergers are built from every group's version-2 picture at the heads and
//             the view switches (its old entry ends 'redeployed'). Planted 'mixver': the merger takes pieces of
//             another version as its own.
//   wire      every frame and picture is copied as it crosses to the merger (src/fold.mjs copy), as a socket would.
// The oracle, after every delivery: for each fold, every touched bucket against ONE PROCESS FOLDING EVERY ROW of the
// merger's cut in key order (src/fold.mjs reference); in full every 500 deliveries and after every event. A lawful
// fold gives that answer whatever the grouping; an unlawful one need not.
// fero's own checks, counted apart: the self-check at build (a seeded law check over pieces of the group's real
// rows, at step 150 and when a group gains version 2; on the first 4 groups each time), the audit (every 100 steps one group's partials compare their kept
// pieces with their rows'), and the resync check (a picture taken at the merger's place must equal its part).
//   node src/sim.mjs --groups=4 --commits=400 --keys=300 --seeds=1000 [--deploy] [--mutate=nopair|resyncadd|norescan|mixver] [--bug=<name>]
import { rng, SLOTS, slotOf, canon, cmpStr, makeRow, genPoints, genRoom, keyName } from './lib.mjs'
import { UPartial, UMerger, reference, referenceAll, selfCheck, copy } from './fold.mjs'
import { makeFolds, userBug } from './folds.mjs'
import { appendFileSync } from 'node:fs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const flag = (n) => process.argv.includes('--' + n)
const GROUPS = arg('groups', '4'), COMMITS = +arg('commits', '400'), KEYS = +arg('keys', '300')
const MUTATE = arg('mutate', ''), BUG = arg('bug', ''), SEEDS = +arg('seeds', '0'), SEED0 = +arg('seed', '1')
const DEPLOY = flag('deploy'), NOKEEPS = flag('nokeeps'), FLAT = flag('flat'), OUT = arg('out', ''), TAG = arg('tag', '')
const STOP = !BUG // a user bug's run goes on to the end, so every check gets its chance
const LAG = 100, FULL_EVERY = 500, AUDIT_EVERY = 100, SELF_AT = 150, SPREAD = +arg('spread', '300'), OVERLAP = +arg('overlap', '0')
const foldsAt = (v) => (BUG ? [userBug(BUG)] : makeFolds(v))
const wire = copy // every frame and picture is copied as it crosses to the merger

function runSeed(SEED) {
  const R = rng(SEED), RM = rng(SEED * 7919 + 3), RC = rng(SEED * 104729 + 11)
  const st = { seed: SEED, steps: 0, applied: 0, pairs: 0, slotsMoved: 0, grows: 0, shrinks: 0, resyncs: 0, atCut: 0, outages: 0, rebuilds: 0,
    deployed: 0, deployWin: 0, stallSteps: 0, markerStalls: 0, maxLag: 0, checks: 0, full: 0, mismatches: 0, first: null, flicker: 0,
    selfFlag: null, selfRuns: 0, rescans: 0, kept: 0, audits: 0, auditFlags: 0, drift: 0, rescanRows: 0, emits: 0, frames: 0, frameParts: 0 }
  const fail = (what, detail) => { st.mismatches++; if (!st.first) st.first = { step: st.steps, what, detail: String(detail).slice(0, 240) }; if (STOP) throw new Stop() }
  // ── the groups, at their heads ────────────────────────────────────────────────────────────────────
  const owner = new Int32Array(SLOTS), seq = new Int32Array(SLOTS)
  const groups = new Map() // gid -> { slots, q, retired, rows, parts: Map v -> [UPartial], v2At, v1End }
  let nextGid = 0, deployAt = DEPLOY ? Math.floor(COMMITS * (0.2 + 0.3 * RC())) : Infinity, deploying = false, firstUp = 0
  const partsFor = (g, v) => foldsAt(v).map((F) => new UPartial(g, F, { mutate: MUTATE, nokeeps: NOKEEPS, flat: FLAT }))
  const mkGroup = () => {
    const g = nextGid++, parts = new Map()
    for (const v of deploying ? [1, 2] : [mver]) parts.set(v, partsFor(g, v))
    groups.set(g, { slots: new Set(), q: [], retired: false, rows: new Map(), parts, v2At: deploying ? 0 : Infinity, v1End: deploying ? st.steps + Math.floor(RC() * (OVERLAP + 1)) : Infinity })
    return g
  }
  let mver = 1
  const G0 = GROUPS === 'elastic' ? 1 : +GROUPS
  for (let i = 0; i < G0; i++) mkGroup()
  for (let s = 0; s < SLOTS; s++) { owner[s] = Math.floor((s * G0) / SLOTS); groups.get(owner[s]).slots.add(s) }
  const keys = Array.from({ length: KEYS }, (_, i) => keyName(i)), slotOfKey = new Map(keys.map((k) => [k, slotOf(k)]))
  const slotKeys = new Map(); for (const k of keys) { const s = slotOfKey.get(k); if (!slotKeys.has(s)) slotKeys.set(s, []); slotKeys.get(s).push(k) }
  // ── the merger's side: one merger per fold, the cut's truth, who owned each slot at the cut ─────────────
  let FS = foldsAt(mver), M = FS.map((F) => new UMerger(F, { mutate: MUTATE }))
  const cut = new Map(), mOwner = new Int32Array(SLOTS), applied = new Int32Array(SLOTS)
  for (let s = 0; s < SLOTS; s++) mOwner[s] = owner[s]
  let idx = FS.map(() => new Map()) // per fold: bucket -> Set of keys at the cut (the oracle's index)
  const ix = (i, k, row, sign) => { if (!row) return; for (const [bk] of FS[i].emit(row)) { const b = canon(bk); let s = idx[i].get(b); if (!s) idx[i].set(b, (s = new Set())); if (sign > 0) s.add(k); else { s.delete(k); if (!s.size) idx[i].delete(b) } } }
  const truthSet = (k, row) => { const o = cut.get(k); for (let i = 0; i < FS.length; i++) ix(i, k, o, -1); if (row) { cut.set(k, row); for (let i = 0; i < FS.length; i++) ix(i, k, row, 1) } else cut.delete(k) }
  const reindex = () => { idx = FS.map(() => new Map()); for (const [k, row] of cut) for (let i = 0; i < FS.length; i++) ix(i, k, row, 1) }
  const down = new Map()
  // ── the oracle ─────────────────────────────────────────────────────────────────────────────────────
  const sorted = (s) => [...s].sort(cmpStr)
  const checkB = (i, b) => {
    const got = M[i].out(b), want = reference(FS[i], cut, sorted(idx[i].get(b) ?? []), b)
    if (canon(got) !== canon(want)) fail(FS[i].name + ' ' + b, canon(got) + ' vs ' + canon(want))
  }
  const touchedOf = (fr) => [...fr.inv.map((x) => x[0]), ...fr.set.map((x) => x[0])]
  const checkTouched = (frs) => { st.checks++; for (let i = 0; i < FS.length; i++) { const bs = new Set(); for (const f of frs) if (f) for (const b of touchedOf(f[i])) bs.add(b); for (const b of bs) checkB(i, b) } }
  const checkFull = () => {
    st.full++; st.checks++
    for (let i = 0; i < FS.length; i++) {
      const want = referenceAll(FS[i], cut, sorted(cut.keys())), got = new Map(M[i].buckets().map((b) => [b, M[i].out(b)]))
      if (canon(got) !== canon(want)) { const bs = [...new Set([...got.keys(), ...want.keys()])].filter((b) => canon(got.get(b)) !== canon(want.get(b))); fail(FS[i].name + '(full) ' + bs[0], canon(got.get(bs[0])) + ' vs ' + canon(want.get(bs[0]))) }
    }
  }
  // ── the merger takes one delivery ────────────────────────────────────────────────────────────────
  const applyRecs = (g, d) => {
    for (const r of d.recs) {
      if (mOwner[r.slot] !== g && MUTATE !== 'nopair') fail('owner', 'slot ' + r.slot + ' from ' + g)
      if (applied[r.slot] + 1 !== r.sseq) fail('slot order', 'slot ' + r.slot)
      applied[r.slot] = r.sseq
      truthSet(r.k, r.next)
    }
  }
  const pickV = (m) => m.get(mver) ?? (MUTATE === 'mixver' ? [...m.values()][0] : undefined) // a piece of my version only
  const take = (g) => {
    const gr = groups.get(g), d = gr.q[0]
    if (d.marker) { if (MUTATE !== 'mixver') { st.markerStalls++; return false } gr.q.shift(); return true }
    if (d.pair) {
      const other = d.A === g ? d.B : d.A
      if (groups.get(other).q[0] !== d || down.has(other)) return false
      const fa = pickV(d.fence), fb = pickV(d.open)
      if (!fa || !fb) { st.markerStalls++; return false }
      groups.get(d.A).q.shift(); groups.get(d.B).q.shift()
      const before = []
      const bs = FS.map((_, i) => new Set([...touchedOf(fa[i]), ...touchedOf(fb[i])]))
      for (let i = 0; i < FS.length; i++) for (const b of bs[i]) before.push(canon(M[i].out(b)))
      for (let i = 0; i < FS.length; i++) { M[i].apply(d.A, wire(fa[i])); M[i].apply(d.B, wire(fb[i])) }
      for (const s of d.slots) mOwner[s] = d.B
      let j = 0
      for (let i = 0; i < FS.length; i++) for (const b of bs[i]) if (canon(M[i].out(b)) !== before[j++]) st.flicker++ // a move changes no row
      st.applied++
      checkTouched([fa, fb])
      return true
    }
    const fr = pickV(d.frames)
    if (!fr) { st.markerStalls++; return false }
    gr.q.shift()
    if (d.half === 'open') for (const s of d.slots) mOwner[s] = g
    applyRecs(g, d)
    for (let i = 0; i < FS.length; i++) M[i].apply(g, wire(fr[i]))
    st.applied++
    checkTouched([fr])
    return true
  }
  const takeFrom = (g0) => {
    let g = g0
    for (let i = 0; i < 64; i++) {
      const d = groups.get(g)?.q[0]
      if (!d || down.has(g)) return false
      if (take(g)) return true
      if (!d.pair) return false
      g = d.A === g ? d.B : d.A
    }
    return false
  }
  // ── rule 4: a group's part replaced by a new host's picture ─────────────────────────────────────────
  const resync = (g) => {
    const gr = groups.get(g)
    if (!gr.parts.has(mver)) return // its host already runs the next version: the old merger is stalled on it anyway
    let lim = 0
    while (lim < gr.q.length && !gr.q[lim].pair && !gr.q[lim].half && !gr.q[lim].marker && gr.q[lim].frames.has(mver)) lim++
    const m = Math.floor(R() * (lim + 1))
    for (let i = 0; i < m; i++) applyRecs(g, gr.q[i])
    gr.q.splice(0, m)
    const rows = []
    for (const [k, row] of cut) if (mOwner[slotOfKey.get(k)] === g) rows.push([k, row])
    for (let i = 0; i < FS.length; i++) { const p2 = new UPartial(g, FS[i]); p2.takeRows(rows); M[i].install(g, wire(p2.state), m === 0) }
    st.resyncs++; if (m === 0) st.atCut++
    checkFull()
  }
  // the truth side takes every queued commit in an order a merger could (moves paired); the cut jumps to the heads
  const drainToHeads = () => {
    for (let guard = 0; guard < 1e7; guard++) {
      const g0 = [...groups.keys()].find((x) => groups.get(x).q.length)
      if (g0 === undefined) break
      let g = g0
      for (let i = 0; i < 64; i++) {
        const d = groups.get(g).q[0]
        if (d.pair) {
          const other = d.A === g ? d.B : d.A
          if (groups.get(other).q[0] !== d) { g = other; continue }
          groups.get(d.A).q.shift(); groups.get(d.B).q.shift()
          for (const s of d.slots) mOwner[s] = d.B
        } else { groups.get(g).q.shift(); if (d.half === 'open') for (const s of d.slots) mOwner[s] = g; if (d.recs) applyRecs(g, d) }
        break
      }
    }
    down.clear()
  }
  const buildMergers = () => {
    M = FS.map((F) => new UMerger(F, { mutate: MUTATE }))
    for (const [g, gr] of groups) for (let i = 0; i < FS.length; i++) M[i].install(g, wire(gr.parts.get(mver)[i].state))
    checkFull()
  }
  const rebuildMerger = () => { if (deploying) return; drainToHeads(); buildMergers(); st.rebuilds++ }
  // ── the deploy: a group gains a version-2 partial, then loses its version-1 partial ─────────────────────
  const deployStep = () => {
    let gone = false
    for (const [g, gr] of groups) {
      if (gr.v2At <= st.steps && !gr.parts.has(2)) { const ps = partsFor(g, 2); for (const p of ps) p.takeRows([...gr.rows]); gr.parts.set(2, ps); selfAll(gr, 2) }
      if (gr.v1End <= st.steps && gr.parts.has(1)) { gr.parts.delete(1); gr.q.push({ marker: true }); if (!firstUp) firstUp = st.steps }
      if (!gr.parts.has(1)) gone = true
    }
    if (gone) st.stallSteps++
  }
  const maybeSwitch = () => {
    if (!deploying) return
    for (const gr of groups.values()) if (!gr.parts.has(2)) return
    drainToHeads()
    for (const gr of groups.values()) { gr.parts.delete(1); gr.v2At = gr.v1End = Infinity }
    mver = 2; FS = foldsAt(2); reindex(); buildMergers()
    deploying = false; st.deployed++; st.deployWin = firstUp ? st.steps - firstUp : 0
  }
  const selfGroups = new Map() // version -> groups checked: each partial host checks at build; the run checks the first 4
  const selfAll = (gr, v) => {
    if (st.selfFlag || !gr.parts.has(v) || (selfGroups.get(v) ?? 0) >= 4) return
    selfGroups.set(v, (selfGroups.get(v) ?? 0) + 1)
    const RS = rng(SEED * 31 + v)
    for (const p of gr.parts.get(v)) { st.selfRuns++; const r = selfCheck(p.F, p.rows, RS); if (r) { st.selfFlag = p.F.name + ': ' + r; return } }
  }
  // ── one commit at a group ──────────────────────────────────────────────────────────────────────────
  const commit = () => {
    const k = keys[Math.floor(R() * KEYS)]
    const g = owner[slotOfKey.get(k)], gr = groups.get(g)
    const ks = [k]
    if (R() < 0.05) for (let i = 0; i < 4; i++) { const k2 = keys[Math.floor(R() * KEYS)]; if (owner[slotOfKey.get(k2)] === g && !ks.includes(k2)) ks.push(k2) }
    const changes = [], recs = []
    for (const k of ks) {
      const prev = gr.rows.get(k)
      let next
      const u = R()
      if (!prev) next = makeRow(k, 'dirty', R)
      else if (u < 0.4) next = makeRow(k, 'dirty', R)
      else if (u < 0.7) { next = { ...prev }; const v = genPoints('dirty', R); if (v === undefined) delete next.points; else next.points = v }
      else if (u < 0.8) next = { ...prev, room: genRoom('dirty', R) }
      else next = undefined
      const s = slotOfKey.get(k)
      changes.push({ k, prev, next })
      recs.push({ k, slot: s, sseq: ++seq[s], next })
      if (next) gr.rows.set(k, next); else gr.rows.delete(k)
    }
    const frames = new Map()
    for (const [v, ps] of gr.parts) frames.set(v, ps.map((p) => p.apply(changes)))
    for (const fr of frames.values()) for (const f of fr) { st.frameParts++; if (!f.inv.length && !f.set.length) st.frameParts-- }
    st.frames++
    gr.q.push({ frames, recs })
  }
  const move = (A, B, slots) => {
    const a = groups.get(A), b = groups.get(B)
    const out = [], inn = []
    for (const s of slots) for (const k of slotKeys.get(s) ?? []) { const row = a.rows.get(k); if (row) { out.push(k); inn.push([k, row]) } }
    const fence = new Map(), open = new Map()
    for (const [v, ps] of a.parts) fence.set(v, ps.map((p) => p.dropRows(out)))
    for (const [v, ps] of b.parts) open.set(v, ps.map((p) => p.takeRows(inn)))
    for (const k of out) { b.rows.set(k, a.rows.get(k)); a.rows.delete(k) }
    for (const s of slots) { owner[s] = B; a.slots.delete(s); b.slots.add(s) }
    if (MUTATE === 'nopair') {
      a.q.push({ half: 'fence', frames: fence, recs: [], slots })
      b.q.push({ half: 'open', frames: open, recs: [], slots })
    } else { const d = { pair: true, A, B, fence, open, slots }; a.q.push(d); b.q.push(d) }
    st.pairs++; st.slotsMoved += slots.length
  }
  const pickSlots = (gr, n) => { const all = [...gr.slots]; const out = []; while (out.length < n && all.length) out.push(all.splice(Math.floor(RM() * all.length), 1)[0]); return out }
  // ── the run ────────────────────────────────────────────────────────────────────────────────────────
  try {
    for (st.steps = 1; st.steps <= COMMITS; st.steps++) {
      commit()
      if (st.steps === SELF_AT) for (const gr of groups.values()) selfAll(gr, mver)
      if (st.steps === deployAt) { deploying = true; for (const gr of groups.values()) { gr.v2At = st.steps + Math.floor(RC() * SPREAD); gr.v1End = gr.v2At + Math.floor(RC() * (OVERLAP + 1)) } }
      if (deploying) deployStep()
      const u = RM()
      if (u < 1 / 250) {
        const live = [...groups].filter(([, gr]) => !gr.retired && gr.slots.size > 0)
        if (GROUPS === 'elastic' && RM() < 0.5) {
          if (RM() < 0.5 && live.length < 16) {
            const [A, a] = live[Math.floor(RM() * live.length)]
            if (a.slots.size >= 2) { const B = mkGroup(); move(A, B, pickSlots(a, a.slots.size >> 1)); st.grows++ }
          } else if (live.length > 1) {
            const i = Math.floor(RM() * live.length); const [A, a] = live[i]; const [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
            move(A, B, [...a.slots]); a.retired = true; st.shrinks++
          }
        } else if (live.length > 1) {
          const i = Math.floor(RM() * live.length); const [A, a] = live[i]; const [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
          const n = [1, 8, 64][Math.floor(RM() * 3)]
          if (a.slots.size > 1) move(A, B, pickSlots(a, Math.min(n, a.slots.size - 1)))
        }
      } else if (u < 1 / 250 + 4 / 1000) { const gs = [...groups.keys()].filter((g) => !down.has(g)); if (gs.length) resync(gs[Math.floor(RM() * gs.length)]) }
      else if (u < 1 / 250 + 4 / 1000 + 1 / 1000) { const gs = [...groups.keys()].filter((g) => !down.has(g)); if (gs.length) { down.set(gs[Math.floor(RM() * gs.length)], st.steps + 20 + Math.floor(RM() * 100)); st.outages++ } }
      else if (u < 1 / 250 + 4 / 1000 + 1 / 1000 + 1 / 1000) rebuildMerger()
      for (const [g, until] of [...down]) if (st.steps >= until) { down.delete(g); resync(g) }
      for (const [g, gr] of groups) if (gr.q.length > LAG && !down.has(g)) while (gr.q.length > LAG / 2 && takeFrom(g));
      const n = Math.floor(RM() * 4), gs = [...groups.keys()]
      for (let i = 0; i < n; i++) { const g = gs[Math.floor(RM() * gs.length)]; if (groups.get(g).q.length) takeFrom(g) }
      maybeSwitch()
      for (const [g, gr] of groups) { st.maxLag = Math.max(st.maxLag, gr.q.length); if (gr.retired && !gr.q.length && !gr.slots.size) { for (const m of M) m.dropGroup(g); groups.delete(g) } }
      if (st.applied && st.applied % FULL_EVERY === 0) checkFull()
      if (st.steps % AUDIT_EVERY === 0) { const gs2 = [...groups.values()]; const gr = gs2[Math.floor(RM() * gs2.length)]; for (const ps of gr.parts.values()) for (const p of ps) { st.audits++; if (!p.audit()) st.auditFlags++ } }
    }
    for (const g of [...down.keys()]) { down.delete(g); resync(g) }
    if (deploying) { for (const gr of groups.values()) gr.v2At = gr.v1End = st.steps; deployStep() }
    for (let guard = 0; guard < 1e7; guard++) { const g = [...groups.keys()].find((x) => groups.get(x).q.length && !groups.get(x).q[0].marker); if (g === undefined) break; if (!takeFrom(g)) break }
    maybeSwitch()
    checkFull()
  } catch (e) { if (!(e instanceof Stop)) throw e }
  for (const m of M) st.drift += m.drift
  for (const gr of groups.values()) for (const ps of gr.parts.values()) for (const p of ps) { st.rescanRows += p.rescanRows; st.emits += p.emits; st.rescans += p.rescans; st.kept += p.kept }
  st.groupsAtEnd = groups.size
  return st
}
class Stop extends Error {}

const label = { run: 'seeds', groups: GROUPS, keys: KEYS, commits: COMMITS, deploy: DEPLOY, overlap: DEPLOY ? OVERLAP : undefined, keeps: !NOKEEPS, flat: FLAT, mutate: MUTATE || 'none', bug: BUG || 'none', tag: TAG }
let agg = { seeds: SEEDS || 1, failed: 0, selfFlagged: 0, auditFlagged: 0, driftFlagged: 0, flickerSeeds: 0, anyFero: 0, checks: 0, mismatches: 0, pairs: 0, slotsMoved: 0,
  resyncs: 0, atCut: 0, outages: 0, rebuilds: 0, deployed: 0, deployWinMax: 0, stallSteps: 0, markerStalls: 0, maxLag: 0, grows: 0, shrinks: 0, frames: 0, frameParts: 0, rescans: 0, kept: 0, laws: {}, firsts: [] }
const t0 = Date.now()
for (let s = SEED0; s < SEED0 + (SEEDS || 1); s++) {
  const st = runSeed(s)
  for (const k of ['checks', 'mismatches', 'pairs', 'slotsMoved', 'resyncs', 'atCut', 'outages', 'rebuilds', 'deployed', 'stallSteps', 'markerStalls', 'grows', 'shrinks', 'frames', 'frameParts', 'rescans', 'kept']) agg[k] += st[k]
  agg.deployWinMax = Math.max(agg.deployWinMax, st.deployWin); agg.maxLag = Math.max(agg.maxLag, st.maxLag)
  if (st.mismatches) { agg.failed++; if (agg.firsts.length < 3) agg.firsts.push({ seed: s, ...st.first }) }
  if (st.selfFlag) { agg.selfFlagged++; const law = st.selfFlag.split(': ')[1]; agg.laws[law] = (agg.laws[law] ?? 0) + 1 }
  if (st.auditFlags) agg.auditFlagged++
  if (st.drift) agg.driftFlagged++
  if (st.flicker) agg.flickerSeeds++
  if (st.selfFlag || st.auditFlags || st.drift) agg.anyFero++
}
const line = JSON.stringify({ ...label, ...agg, ms: Date.now() - t0 })
console.log(line)
if (OUT) appendFileSync(OUT, line + '\n')
if (!BUG && agg.failed && !MUTATE) process.exitCode = 1
