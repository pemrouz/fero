// E-64 O1, the seeded exactness run: a merger fed by G groups' partials, late and interleaved, through slot moves,
// partial failovers, partial outages and merger failovers. Built on E-23 run E's shape and E-57 B1's domain.
//
// The source: one resource of 1,024 slots (E-23's count: more rows per slot) over G groups (4, 16, or elastic:
// 1 to 16, groups made and removed by moves). Each group is a PARTIAL (src/partial.mjs) at its head: every
// commit of the group goes through it and gives one partial frame, queued for the merger in the group's order.
// A slot move (1 to 64 slots, A to B) is one PAIRED delivery that sits in both queues; the merger may take it
// only when it heads both (rule 3). The merger (src/merger.mjs) takes 0 to 3 deliveries a step from random groups
// (so it lags by a random walk), and any queue past LAG is drained first.
// Faults, drawn from the seed:
//   partial failover (1 in 1,000 steps): the group's partial host is replaced; the new host waits until it is at
//     or past the merger's position for that group, then sends a picture; the merger replaces the group's
//     contribution (rule 4)
//   partial outage (1 in 2,000): the merger hears nothing from one group for 50 to 300 steps, then resyncs it
//   merger failover (1 in 3,000): a new merger is built from every group's picture
// The oracle, after every delivery the merger takes: each view against the query run from scratch on the TRUTH at
// the merger's cut (the rows of exactly the commits it has taken), for the touched keys and buckets, and in full
// every 1,000 deliveries and after every event. Each record's slot sequence must be the slot's next one and its
// slot must belong, at the merger's cut, to the group that sent it (the cut is a prefix of every slot's log).
// Every 500 steps: a page of 7 after a random cursor by scatter-gather (both forms) and an exact median by
// selection, both over the groups' heads, against the query over every row.
//   node sim/sim.mjs --groups=4|16|elastic --commits=100000 --seed=1 [--mutate=nopair|ties|kshort|extmerged|resyncadd|noowner]
//   node sim/sim.mjs --seeds=1000 --commits=400 --keys=300 ...    many short seeds; one JSON line
import { rng, SLOTS, slotOf, canon, num, bkey, rowCmp, cmpStr, makeRow, genPoints, genRoom, keyName, exactSum } from '../src/lib.mjs'
import { Partial, PRED, FLAG } from '../src/partial.mjs'
import { Merger } from '../src/merger.mjs'
import { pageScatter, selectRank, rankOf } from '../src/select.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const GROUPS = arg('groups', '4'), COMMITS = +arg('commits', '100000'), KEYS = +arg('keys', '3000')
const MUTATE = arg('mutate', ''), SEEDS = +arg('seeds', '0'), SEED0 = +arg('seed', '1'), DOM = arg('dom', 'dirty')
const K = 10, LAG = 100, FULL_EVERY = 1000
const ZA = rowCmp('points', 'za')
const ECMP = (a, b) => ZA({ points: a.v, id: a.k }, { points: b.v, id: b.k })

function runSeed(SEED) {
  const R = rng(SEED), RM = rng(SEED * 7919 + 3)
  const st = { seed: SEED, steps: 0, applied: 0, pairs: 0, slotsMoved: 0, grows: 0, shrinks: 0, resyncs: 0, outages: 0, rebuilds: 0, maxLag: 0, checks: 0, full: 0, pages: 0, pageSentOne: 0, pageSentTwo: 0, pageRounds2: 0, medians: 0, medianRounds: 0, medianRoundsMax: 0, mismatches: 0, first: null }
  const fail = (what, detail) => { st.mismatches++; if (!st.first) st.first = { step: st.steps, what, detail: String(detail).slice(0, 300) }; throw new Stop() }
  // ── the groups, at their heads ───────────────────────────────────────────────────────────────────
  const owner = new Int32Array(SLOTS), seq = new Int32Array(SLOTS)
  const groups = new Map() // gid -> { p: Partial, slots: Set, q: [] , retired }
  let nextGid = 0
  const mkGroup = () => { const g = nextGid++; groups.set(g, { p: new Partial(g, { KP: K, mutate: MUTATE }), slots: new Set(), q: [], retired: false }); return g }
  const G0 = GROUPS === 'elastic' ? 1 : +GROUPS
  for (let i = 0; i < G0; i++) mkGroup()
  for (let s = 0; s < SLOTS; s++) { owner[s] = Math.floor((s * G0) / SLOTS); groups.get(owner[s]).slots.add(s) }
  const keys = Array.from({ length: KEYS }, (_, i) => keyName(i)), slotOfKey = new Map(keys.map((k) => [k, slotOf(k)]))
  const slotKeys = new Map(); for (const k of keys) { const s = slotOfKey.get(k); if (!slotKeys.has(s)) slotKeys.set(s, []); slotKeys.get(s).push(k) }
  // ── the merger's side: the merger, its cut's truth, who owned each slot at its cut ────────────────────
  let M = new Merger({ K, mutate: MUTATE })
  const cut = new Map(), mOwner = new Int32Array(SLOTS), applied = new Int32Array(SLOTS)
  for (let s = 0; s < SLOTS; s++) mOwner[s] = owner[s]
  const cutB = new Map() // the oracle's grouping of the cut's keys by bucket (an index, not a view)
  const bIdx = (k, row, sign) => { const b = row && bkey(row.room); if (b === undefined) return; let s = cutB.get(b); if (!s) cutB.set(b, (s = new Set())); if (sign > 0) s.add(k); else { s.delete(k); if (!s.size) cutB.delete(b) } }
  const truthSet = (k, row) => { const o = cut.get(k); bIdx(k, o, -1); if (row) { cut.set(k, row); bIdx(k, row, 1) } else cut.delete(k) }
  const down = new Map() // gid -> step it comes back
  // ── the oracle: queries from scratch on the cut's truth ─────────────────────────────────────────────
  const qTop = () => { const best = []; for (const [k, row] of cut) { const e = { ...row, id: k }; let i = best.length; while (i > 0 && ZA(e, best[i - 1]) < 0) i--; if (i < K) { best.splice(i, 0, e); if (best.length > K) best.pop() } } return best.map((e) => e.id) }
  const members = (b) => (b === '*' ? [...cut.keys()] : [...(cutB.get(b) ?? [])])
  const qAdd = (b) => { const ks = members(b); if (!ks.length) return undefined; return [ks.length, exactSum(ks.map((k) => num(cut.get(k).points)).filter((x) => x !== undefined))] }
  const qExt = (b) => { let m; for (const k of members(b)) { const x = num(cut.get(k).points); if (x !== undefined) m = m === undefined ? x : Math.max(m, x) } return m }
  const qDis = (b) => { let mk; for (const k of members(b)) if (mk === undefined || cmpStr(k, mk) < 0) mk = k; return mk === undefined ? undefined : cut.get(mk).room }
  const qBool = () => { for (const row of cut.values()) if (FLAG(row)) return true; return false }
  const eq = (a, b) => canon(a) === canon(b)
  const checkTouched = (parts) => {
    st.checks++
    const top = M.topK(), qt = qTop()
    if (!eq(top, qt)) fail('window', canon(top) + ' vs ' + canon(qt))
    const bs = new Set(['*'])
    for (const p of parts) { for (const d of p.add) bs.add(d[0]); for (const d of p.ext) bs.add(d[0]); for (const d of p.dis) bs.add(d[0]) }
    for (const b of bs) {
      if (!eq(M.addOut(b), qAdd(b))) fail('add ' + b, canon(M.addOut(b)) + ' vs ' + canon(qAdd(b)))
      if (b === '*') continue
      if (!eq(M.extOut(b), qExt(b))) fail('ext ' + b, canon(M.extOut(b)) + ' vs ' + canon(qExt(b)))
      if (!eq(M.disOut(b), qDis(b))) fail('dis ' + b, canon(M.disOut(b)) + ' vs ' + canon(qDis(b)))
    }
    for (const p of parts) for (const k of [...p.uni.drop, ...p.uni.put.map((x) => x[0])]) {
      const row = cut.get(k), want = row !== undefined && PRED(row), e = M.uni.get(k)
      if (want !== (e !== undefined) || (want && e.row !== row)) fail('union ' + k, canon(e?.row) + ' vs ' + canon(row))
    }
    if (M.boolOut() !== qBool()) fail('bool', M.boolOut())
  }
  const checkFull = () => {
    st.full++
    checkTouched([])
    const bs = new Set([...cutB.keys(), ...M.add.keys(), ...M.ext.keys(), ...M.dis.keys()])
    for (const b of bs) {
      if (!eq(M.addOut(b), qAdd(b))) fail('add(full) ' + b, canon(M.addOut(b)) + ' vs ' + canon(qAdd(b)))
      if (b === '*') continue
      if (!eq(M.extOut(b), qExt(b))) fail('ext(full) ' + b, canon(M.extOut(b)) + ' vs ' + canon(qExt(b)))
      if (!eq(M.disOut(b), qDis(b))) fail('dis(full) ' + b, canon(M.disOut(b)) + ' vs ' + canon(qDis(b)))
    }
    let n = 0
    for (const [k, row] of cut) if (PRED(row)) { n++; const e = M.uni.get(k); if (!e || e.row !== row) fail('union(full) ' + k, canon(e?.row)) }
    if (n !== M.uni.size) fail('union(full) size', M.uni.size + ' vs ' + n)
  }
  // ── the merger takes one delivery from a group (a paired move only when it heads both queues) ───────────
  const applyRecs = (g, d) => {
    for (const r of d.recs) {
      if (mOwner[r.slot] !== g && MUTATE !== 'nopair') fail('owner', 'slot ' + r.slot + ' from ' + g + ' owned by ' + mOwner[r.slot])
      if (applied[r.slot] + 1 !== r.sseq) fail('slot order', 'slot ' + r.slot + ' got ' + r.sseq + ' after ' + applied[r.slot])
      applied[r.slot] = r.sseq
      truthSet(r.k, r.next)
    }
  }
  const take = (g) => {
    const gr = groups.get(g)
    const d = gr.q[0]
    if (d.pair) {
      const other = d.A === g ? d.B : d.A
      if (groups.get(other).q[0] !== d || down.has(other)) return false
      groups.get(d.A).q.shift(); groups.get(d.B).q.shift()
      M.apply(d.A, d.fence); M.apply(d.B, d.open)
      for (const s of d.slots) mOwner[s] = d.B
      M.frame(); st.applied++
      checkTouched([d.fence, d.open])
      return true
    }
    gr.q.shift()
    if (d.half === 'open') for (const s of d.slots) mOwner[s] = g // the planted unpaired move: each half alone
    applyRecs(g, d)
    M.apply(g, d.parts)
    M.frame(); st.applied++
    checkTouched([d.parts])
    return true
  }
  const takeFrom = (g0) => { // follow a paired move to the queue that must move first
    let g = g0
    for (let i = 0; i < 64; i++) {
      const d = groups.get(g)?.q[0]
      if (!d || down.has(g)) return false
      if (take(g)) return true
      g = d.A === g ? d.B : d.A
    }
    return false
  }
  // ── rule 4: a group's partial is replaced (failover, or the end of an outage) ─────────────────────────
  const resync = (g, rule = true) => {
    const gr = groups.get(g)
    // the new host waits until it is at or past the merger's position, then takes its picture: here, at the
    // merger's cut plus the first m queued commits (never past a queued move, which the merger takes as a pair)
    let lim = 0
    while (lim < gr.q.length && !gr.q[lim].pair && !gr.q[lim].half) lim++
    const m = Math.floor(R() * (lim + 1))
    for (let i = 0; i < m; i++) applyRecs(g, gr.q[i])
    gr.q.splice(0, m)
    const p2 = new Partial(g, { KP: K, mutate: MUTATE })
    const rows = []
    for (const [k, row] of cut) if (mOwner[slotOfKey.get(k)] === g) rows.push([k, row])
    p2.takeRows(rows)
    M.install(g, p2.picture())
    // the live host goes on from the head; if the picture was taken behind the head, the frames after it are the
    // queued ones (still in the queue): the new host's frames from the picture's place on are the same frames
    M.frame(); st.resyncs++
    checkFull()
  }
  const rebuildMerger = () => {
    // a new merger: every group's picture at its head; the cut jumps to the heads (never back). The truth side
    // takes the queued commits in an order the merger could have taken them (moves paired)
    for (;;) {
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
        } else { groups.get(g).q.shift(); if (d.half === 'open') for (const s of d.slots) mOwner[s] = g; applyRecs(g, d) }
        break
      }
    }
    for (const gr of groups.values()) gr.q = []
    down.clear()
    M = new Merger({ K, mutate: MUTATE })
    for (const [g, gr] of groups) M.install(g, gr.p.picture())
    M.frame(); st.rebuilds++
    checkFull()
  }
  // ── one commit at a group ────────────────────────────────────────────────────────────────────────
  const commit = () => {
    let k = keys[Math.floor(R() * KEYS)]
    const g = owner[slotOfKey.get(k)], gr = groups.get(g)
    const ks = [k]
    if (R() < 0.05) for (let i = 0; i < 4; i++) { const k2 = keys[Math.floor(R() * KEYS)]; if (owner[slotOfKey.get(k2)] === g && !ks.includes(k2)) ks.push(k2) }
    const changes = [], recs = []
    for (const k of ks) {
      const prev = gr.p.rows.get(k)
      let next
      const u = R()
      if (!prev) next = makeRow(k, DOM, R)
      else if (u < 0.4) next = makeRow(k, DOM, R)
      else if (u < 0.7) { next = { ...prev }; const v = genPoints(DOM, R); if (v === undefined) delete next.points; else next.points = v }
      else if (u < 0.8) next = { ...prev, room: genRoom(DOM, R) }
      else next = undefined
      const s = slotOfKey.get(k)
      changes.push({ k, prev, next })
      recs.push({ k, slot: s, sseq: ++seq[s], next })
    }
    gr.q.push({ parts: gr.p.apply(changes), recs })
  }
  // ── a slot move, as one paired delivery (or, planted, two halves) ───────────────────────────────────
  const move = (A, B, slots) => {
    const a = groups.get(A), b = groups.get(B)
    const out = [], inn = []
    for (const s of slots) for (const k of slotKeys.get(s) ?? []) { const row = a.p.rows.get(k); if (row) { out.push(k); inn.push([k, row]) } }
    const fence = a.p.dropRows(out), open = b.p.takeRows(inn)
    for (const s of slots) { owner[s] = B; a.slots.delete(s); b.slots.add(s) }
    if (MUTATE === 'nopair') {
      a.q.push({ half: 'fence', parts: fence, recs: [], slots })
      b.q.push({ half: 'open', parts: open, recs: [], slots })
    } else { const d = { pair: true, A, B, fence, open, slots }; a.q.push(d); b.q.push(d) }
    st.pairs++; st.slotsMoved += slots.length
  }
  const pickSlots = (gr, n) => { const all = [...gr.slots]; const out = []; while (out.length < n && all.length) out.push(all.splice(Math.floor(RM() * all.length), 1)[0]); return out }
  // ── reads over every row by scatter-gather, at the groups' heads ──────────────────────────────────────
  const checkReads = () => {
    const live = [...groups.values()].filter((gr) => gr.p.rows.size > 0 || !gr.retired)
    const ixs = live.map((gr) => gr.p.ix)
    const all = []
    for (const gr of live) for (const [k, row] of gr.p.rows) all.push({ v: row.points, k })
    all.sort(ECMP)
    const n = 7
    let cur = null
    if (all.length && R() < 0.8) { const e = all[Math.floor(R() * all.length)]; cur = [e.v, e.k] }
    const want = (cur ? all.filter((e) => ECMP(e, { v: cur[0], k: cur[1] }) > 0) : all).slice(0, n).map((e) => e.k)
    for (const form of ['one', 'two']) {
      const r = pageScatter(ixs, cur, n, form, ECMP)
      const got = r.page.map((e) => e.k)
      if (!eq(got, want)) fail('page ' + form, canon(got) + ' vs ' + canon(want))
      if (form === 'one') st.pageSentOne += r.sent; else { st.pageSentTwo += r.sent; if (r.rounds === 2) st.pageRounds2++ }
    }
    st.pages++
    // an exact median (data's quantile, type 7) of the numbers, by selection; numbers come first in za
    const probe = { v: '', k: '' }
    const counts = ixs.map((ix) => rankOf(ix, probe.v, probe.k))
    const ntot = counts.reduce((a, b) => a + b, 0)
    const vals = all.filter((e) => num(e.v) !== undefined).map((e) => e.v).sort((a, b) => a - b)
    if (ntot !== vals.length) fail('median count', ntot + ' vs ' + vals.length)
    if (!ntot) return
    const h = (ntot - 1) * 0.5, lo = Math.floor(h), frac = h - lo
    const at = (asc) => { const r = selectRank(ixs, counts, ntot - 1 - asc, ECMP); st.medianRounds += r.rounds; st.medianRoundsMax = Math.max(st.medianRoundsMax, r.rounds); return r.e.v }
    const a = at(lo), med = frac === 0 ? a : a + frac * (at(lo + 1) - a)
    const wantMed = frac === 0 ? vals[lo] : vals[lo] + frac * (vals[lo + 1] - vals[lo])
    if (!eq(med, wantMed)) fail('median', med + ' vs ' + wantMed)
    st.medians++
  }
  // ── the run ─────────────────────────────────────────────────────────────────────────────────────
  try {
    for (st.steps = 1; st.steps <= COMMITS; st.steps++) {
      commit()
      const u = RM()
      if (u < 1 / 250) {
        const live = [...groups].filter(([, gr]) => !gr.retired && gr.slots.size > 0)
        if (GROUPS === 'elastic' && RM() < 0.5) {
          if (RM() < 0.5 && live.length < 16) { // grow: half of a group's slots to a new group
            const [A, a] = live[Math.floor(RM() * live.length)]
            if (a.slots.size >= 2) { const B = mkGroup(); M.pos.set(B, 0); move(A, B, pickSlots(a, a.slots.size >> 1)); st.grows++ }
          } else if (live.length > 1) { // shrink: all of a group's slots to another; the group goes once drained
            const i = Math.floor(RM() * live.length); const [A, a] = live[i]; const [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
            move(A, B, [...a.slots]); a.retired = true; st.shrinks++
          }
        } else if (live.length > 1) {
          const i = Math.floor(RM() * live.length); const [A, a] = live[i]; const [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
          const n = [1, 8, 64][Math.floor(RM() * 3)]
          if (a.slots.size > 1) move(A, B, pickSlots(a, Math.min(n, a.slots.size - 1)))
        }
      } else if (u < 1 / 250 + 1 / 1000) { const gs = [...groups.keys()].filter((g) => !down.has(g)); if (gs.length) resync(gs[Math.floor(RM() * gs.length)]) }
      else if (u < 1 / 250 + 1 / 1000 + 1 / 2000) { const gs = [...groups.keys()].filter((g) => !down.has(g)); if (gs.length) { down.set(gs[Math.floor(RM() * gs.length)], st.steps + 50 + Math.floor(RM() * 250)); st.outages++ } }
      else if (u < 1 / 250 + 1 / 1000 + 1 / 2000 + 1 / 3000) rebuildMerger()
      for (const [g, until] of [...down]) if (st.steps >= until) { down.delete(g); resync(g) }
      // the merger: lagging queues first, then 0 to 3 from random groups
      for (const [g, gr] of groups) if (gr.q.length > LAG && !down.has(g)) while (gr.q.length > LAG / 2 && takeFrom(g));
      const n = Math.floor(RM() * 4)
      const gs = [...groups.keys()]
      for (let i = 0; i < n; i++) { const g = gs[Math.floor(RM() * gs.length)]; if (groups.get(g).q.length) takeFrom(g) }
      for (const [g, gr] of groups) { st.maxLag = Math.max(st.maxLag, gr.q.length); if (gr.retired && !gr.q.length && !gr.slots.size) { M.dropGroup(g); groups.delete(g) } }
      if (st.applied && st.applied % FULL_EVERY === 0) checkFull()
      if (st.steps % 500 === 0) checkReads()
    }
    // drain: every outage ends, every queue empties; then the whole answer once more
    for (const g of [...down.keys()]) { down.delete(g); resync(g) }
    for (let guard = 0; guard < 1e7; guard++) { const g = [...groups.keys()].find((x) => groups.get(x).q.length); if (g === undefined) break; takeFrom(g) }
    checkFull(); checkReads()
  } catch (e) { if (!(e instanceof Stop)) throw e }
  st.groupsAtEnd = groups.size
  return st
}
class Stop extends Error {}

if (SEEDS > 0) {
  let failed = 0, checks = 0, pairs = 0, firsts = []
  for (let s = SEED0; s < SEED0 + SEEDS; s++) { const st = runSeed(s); checks += st.checks; pairs += st.pairs; if (st.mismatches) { failed++; if (firsts.length < 3) firsts.push({ seed: s, ...st.first }) } }
  console.log(JSON.stringify({ run: 'seeds', groups: GROUPS, mutate: MUTATE || 'none', seeds: SEEDS, commits: COMMITS, keys: KEYS, failed, checks, pairs, firsts }))
} else {
  const t0 = Date.now(); const st = runSeed(SEED0)
  console.log(JSON.stringify({ run: 'long', groups: GROUPS, mutate: MUTATE || 'none', commits: COMMITS, keys: KEYS, ms: Date.now() - t0, ...st }))
  if (st.mismatches) process.exitCode = 1
}
