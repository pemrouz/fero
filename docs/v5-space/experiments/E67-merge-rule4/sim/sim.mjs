// E-67, the seeded run: O1's merger (src/merger.mjs) behind its intake (src/intake.mjs), fed by G groups whose
// partial hosts fail, go down and come back, while slot moves take their real three steps.
//
// THE WORLD. One resource of 1,024 slots and 300 keys in E-23's dirty domain, over G groups. Each group has a
// log; every copy of a group folds the same log, so its partial frames are the same on every copy. One commit a
// step (5 % touch several rows of one group). A slot move (1, 8 or 64 slots, A to B):
//   planned  (0 to 3 steps; 10 % are cancelled here and leave no trace in any log)
//   fence    A commits a fence: it stops taking the slots; their rows leave A's partial (A's 'fence' half)
//   carry    1 to 8 steps; writes to the slots wait
//   open     B commits an open with the rows (B's 'open' half); or, 15 % of moves, B gives up and A commits
//            an unfence (A's 'unfence' half: the rows come back to A)
// THE HOSTS. A group's partial runs on one copy, its host, which sends each frame to the merger (0 to 3 frames
// a step of delay). A takeover (a failover, or the end of an outage) puts the partial on another copy at its
// own place p', at or past the merger's place (half the time at the head): the merger drops its inbound
// buffer from the old host, and the new host sends a picture at p' (ready 1 to 3 steps later) and then its
// frames from p' on. In fix (b) and (b0) every copy keeps a ring of the last RING frames: when the ring reaches
// back to the merger's place the new host re-sends those frames instead (no picture). An outage (20 to 120
// steps; stress 20 to 140): nothing arrives from the group and nothing is taken from it; it ends with a
// takeover. A merger rebuild: a new merger with no part; every group's host sends a picture at its own place.
// A group that is down at a rebuild stays down (its picture comes when its outage ends): the new merger cannot
// serve until it has every group's part, and the sim counts that gap.
// THE MERGER takes 0 to 3 units a step from random groups (and drains any buffer past 40), each as a join.
//
// THE ORACLE, written apart from the intake. It keeps, per group, that group's rows at the merger's place
// (replayed from the group's own log), and the rows of every move fenced at the cut and not closed there (they
// are real rows, being carried). The truth at the cut is their union; a key held by two of them means the cut
// is not a cut ('twice'). After every join the merger served, its six answers are checked against the queries
// run from scratch on the truth, for the touched keys and buckets; in full every 25 joins, after every picture
// and at the end. Places never go back ('back'). Health (fix a, b, c): each group the merger names held must be
// held, by the down groups the oracle finds from the world's own move table. At the end every outage ends,
// every move finishes, and every buffer must drain ('stuck' if it cannot).
//   node sim/sim.mjs --world=g4|g16|elastic|stress --fix=none|a|b|b0|c [--mutate=...] [--ring=64] --seeds=1000
//   node sim/sim.mjs ... --seed=7 --seeds=1 --trace     one seed, its counters
import { rng, SLOTS, slotOf, canon, num, bkey, rowCmp, cmpStr, makeRow, genPoints, genRoom, keyName, exactSum, toUnits, fromUnits } from '../src/lib.mjs'
import { Partial, PRED, FLAG } from '../src/partial.mjs'
import { Intake } from '../src/intake.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const WORLD = arg('world', 'g4'), FIX = arg('fix', 'a'), MUTATE = arg('mutate', ''), RING = +arg('ring', '64')
const SEEDS = +arg('seeds', '1000'), SEED0 = +arg('seed', '1'), STEPS = +arg('steps', '600'), KEYS = +arg('keys', '300')
const K = 10, LAG = 40, FULL_EVERY = 25, DOM = 'dirty', TAKES = +arg('takes', '2'), DLO = +arg('dlo', '0'), DHI = +arg('dhi', '3')
const WORLDS = {
  g4: { G0: 4, move: 1 / 50, fail: 1 / 100, out: 1 / 400, outLen: [20, 120], rebuild: 1 / 650 },
  g16: { G0: 16, move: 1 / 50, fail: 1 / 100, out: 1 / 400, outLen: [20, 120], rebuild: 1 / 650 },
  elastic: { G0: 1, elastic: true, move: 1 / 50, fail: 1 / 100, out: 1 / 400, outLen: [20, 120], rebuild: 1 / 650 },
  stress: { G0: 8, move: 1 / 9, fail: 1 / 28, out: 1 / 200, outLen: [20, 140], rebuild: 1 / 100 },
}
const W = WORLDS[WORLD]
if (!W) throw new Error('world ' + WORLD)
const CARRIES = FIX === 'a' || FIX === 'b' || FIX === 'c'
const ZA = rowCmp('points', 'za')
class Stop extends Error {}

function runSeed(SEED) {
  const R = rng(SEED), RF = rng(SEED * 7919 + 3), RM = rng(SEED * 31 + 17)
  const ri = (a, b) => a + Math.floor(RM() * (b - a + 1))
  const st = { seed: SEED, joins: 0, checks: 0, full: 0, moves: 0, cancels: 0, fences: 0, opens: 0, giveups: 0, slotsMoved: 0, grows: 0, shrinks: 0, removed: 0,
    takeovers: 0, outages: 0, rebuilds: 0, rebuildsDown: 0, gapSum: 0, gapMax: 0, gapDownSum: 0, gapDownMax: 0, gapN: 0, gapDownN: 0,
    ringHit: 0, ringMiss: 0, pictures: 0, cases: 0, caseTake: 0, caseRebuild: 0, caseFence: 0, caseOpen: 0, caseGiveup: 0, caseMulti: 0,
    joinPics2: 0, waitMove: 0, held: 0, picWait: 0, maxBuf: 0, healthChecks: 0, casesAny: 0, mismatches: 0, first: null, last: 'none' }
  const fail = (what, detail) => { st.mismatches++; if (!st.first) st.first = { step, what, after: st.last, detail: String(detail).slice(0, 240) }; throw new Stop() }
  let step = 0
  const intake = new Intake({ fix: FIX, mutate: MUTATE, K, rnd: rng(SEED * 13 + 5) })
  // ── the world ──────────────────────────────────────────────────────────────────────────────────────
  const groups = new Map() // g -> { log, p (the canonical partial at the head; p.rows are the head's rows), slots, hp, down, until, retiring }
  const owner = new Int32Array(SLOTS), locked = new Uint8Array(SLOTS)
  const moves = new Map() // mv -> { mv, A, B, slots, state, tFence, tClose, giveUp, fpos, cpos, closeG, closeKind, rows, shrink }
  let nextGid = 0, nextMv = 0
  const keys = Array.from({ length: KEYS }, (_, i) => keyName(i)), slotOfKey = new Map(keys.map((k) => [k, slotOf(k)]))
  const slotKeys = new Map(); for (const k of keys) { const s = slotOfKey.get(k); if (!slotKeys.has(s)) slotKeys.set(s, []); slotKeys.get(s).push(k) }
  // ── the oracle's side ───────────────────────────────────────────────────────────────────────────────
  const cutpos = new Map() // g -> the merger's place, as the oracle last advanced it
  const tsrc = new Map() // k -> [[src, row]...]: who holds k at the cut (a group, or 'm<move>' in flight)
  const cut = new Map(), cutB = new Map() // the truth's answer rows, and its keys by bucket
  const touchedK = new Set(), touchedB = new Set()
  // the whole cut's count and exact sum, kept as the truth changes (the same arithmetic as exactSum, apart from
  // the merger's WideSum); a full check recomputes it from scratch
  const star = { n: 0, t: 0n, pinf: 0, ninf: 0, nf: 0, nz: 0 }
  const starAdd = (row, s) => {
    star.n += s
    const x = num(row.points)
    if (x === undefined) return
    if (x === Infinity) { star.pinf += s; return }
    if (x === -Infinity) { star.ninf += s; return }
    star.nf += s
    if (x === 0) { if (Object.is(x, -0)) star.nz += s; return }
    const u = toUnits(x); star.t += s > 0 ? u : -u
  }
  const starOut = () => {
    if (!star.n) return undefined
    let v
    if (star.pinf > 0 && star.ninf > 0) v = NaN
    else if (star.pinf > 0) v = Infinity
    else if (star.ninf > 0) v = -Infinity
    else if (star.nf > 0 && star.nz === star.nf) v = -0
    else { const r = fromUnits(star.t); v = r === 0 ? 0 : r }
    return [star.n, v]
  }
  let oldClosed = new Set() // moves closed by earlier mergers (the copies learn it and stop keeping the rows)
  const mClosed = (mv) => oldClosed.has(mv) || intake.closed.has(mv)
  const mkGroup = () => {
    const g = nextGid++
    groups.set(g, { log: [], p: new Partial(g, { KP: K }), slots: new Set(), hp: 0, down: false, until: 0, retiring: false })
    intake.addGroup(g); cutpos.set(g, 0)
    return g
  }
  for (let i = 0; i < W.G0; i++) mkGroup()
  for (let s = 0; s < SLOTS; s++) { owner[s] = Math.floor((s * W.G0) / SLOTS); groups.get(owner[s]).slots.add(s) }
  const bIdx = (k, row, sign) => { const b = row && bkey(row.room); if (b === undefined) return; let s = cutB.get(b); if (!s) cutB.set(b, (s = new Set())); if (sign > 0) s.add(k); else { s.delete(k); if (!s.size) cutB.delete(b) } }
  const setSrc = (k, src, row) => {
    let l = tsrc.get(k)
    if (!l) tsrc.set(k, (l = []))
    const i = l.findIndex((e) => e[0] === src)
    if (i >= 0) l.splice(i, 1)
    if (row !== undefined) l.push([src, row])
    if (!l.length) tsrc.delete(k)
    const was = cut.get(k), now = l.length ? l[0][1] : undefined
    touchedK.add(k)
    for (const r of [was, now]) if (r) { const b = bkey(r.room); if (b !== undefined) touchedB.add(b) }
    if (was !== now) { bIdx(k, was, -1); if (was) starAdd(was, -1); if (now) { cut.set(k, now); bIdx(k, now, 1); starAdd(now, 1) } else cut.delete(k) }
  }
  const advance = (g, to) => { // the oracle moves its cut for g to `to`, through g's own log
    const from = cutpos.get(g), log = groups.get(g).log
    if (to < from) fail('back', 'group ' + g + ' from ' + from + ' to ' + to)
    for (let p = from + 1; p <= to; p++) {
      const e = log[p - 1]
      if (e.kind === 'w') { for (const [k, row] of e.delta) setSrc(k, g, row); continue }
      const m = moves.get(e.mv), msrc = 'm' + e.mv
      if (e.kind === 'fence') {
        const closed = m.closeG !== undefined && cutpos.get(m.closeG) >= m.cpos && !(m.closeG === g)
        for (const [k, row] of e.rows) { setSrc(k, g, undefined); if (!closed) setSrc(k, msrc, row) }
      } else if (e.kind === 'open') {
        const fenced = cutpos.get(m.A) >= m.fpos
        for (const [k, row] of e.delta) { setSrc(k, g, row); if (fenced) setSrc(k, msrc, undefined) }
      } else { for (const [k, row] of e.delta) { setSrc(k, g, row); setSrc(k, msrc, undefined) } } // unfence
      cutpos.set(g, p)
    }
    cutpos.set(g, to)
  }
  const syncCut = () => { for (const [g, s] of intake.st) if (s.pos !== cutpos.get(g)) advance(g, s.pos) }
  // the queries, from scratch on the truth
  const qTop = () => { // rows carry their key as id (makeRow), so the rows themselves are compared
    const best = []
    for (const row of cut.values()) {
      if (best.length === K && ZA(row, best[K - 1]) >= 0) continue
      let i = best.length; while (i > 0 && ZA(row, best[i - 1]) < 0) i--
      best.splice(i, 0, row); if (best.length > K) best.pop()
    }
    return best.map((e) => e.id)
  }
  const members = (b) => (b === '*' ? [...cut.keys()] : [...(cutB.get(b) ?? [])])
  const qAdd = (b) => { const ks = members(b); if (!ks.length) return undefined; return [ks.length, exactSum(ks.map((k) => num(cut.get(k).points)).filter((x) => x !== undefined))] }
  const qExt = (b) => { let m; for (const k of members(b)) { const x = num(cut.get(k).points); if (x !== undefined) m = m === undefined ? x : Math.max(m, x) } return m }
  const qDis = (b) => { let mk; for (const k of members(b)) if (mk === undefined || cmpStr(k, mk) < 0) mk = k; return mk === undefined ? undefined : cut.get(mk).room }
  const qBool = () => { for (const row of cut.values()) if (FLAG(row)) return true; return false }
  const eq = (a, b) => canon(a) === canon(b)
  const checkBucket = (M, b, tag) => {
    const want = b === '*' && !tag ? starOut() : qAdd(b)
    if (!eq(M.addOut(b), want)) fail('add' + tag + ' ' + b, canon(M.addOut(b)) + ' vs ' + canon(want))
    if (b === '*') return
    if (!eq(M.extOut(b), qExt(b))) fail('ext' + tag + ' ' + b, canon(M.extOut(b)) + ' vs ' + canon(qExt(b)))
    if (!eq(M.disOut(b), qDis(b))) fail('dis' + tag + ' ' + b, canon(M.disOut(b)) + ' vs ' + canon(qDis(b)))
  }
  const checkKey = (M, k) => {
    const l = tsrc.get(k)
    if (l && l.length > 1) fail('twice', k + ' held by ' + l.map((e) => e[0]).join(','))
    const row = cut.get(k), want = row !== undefined && PRED(row), got = M.uniRows(k)
    if (got.length !== (want ? 1 : 0) || (want && got[0] !== row)) fail('union ' + k, canon(got) + ' vs ' + canon(row))
  }
  const checkTouched = () => {
    st.checks++
    const M = intake.M
    if (!eq(M.topK(), qTop())) fail('window', canon(M.topK()) + ' vs ' + canon(qTop()))
    for (const k of touchedK) checkKey(M, k)
    touchedB.add('*')
    for (const b of touchedB) checkBucket(M, b, '')
    if (M.boolOut() !== qBool()) fail('bool', M.boolOut())
    touchedK.clear(); touchedB.clear()
  }
  const checkFull = () => {
    st.full++
    checkTouched()
    const M = intake.M
    for (const [k, l] of tsrc) if (l.length > 1) fail('twice(full)', k)
    for (const b of new Set([...cutB.keys(), ...M.add.keys(), ...M.ext.keys(), ...M.dis.keys(), '*'])) checkBucket(M, b, '(full)')
    let n = 0
    for (const [k, row] of cut) if (PRED(row)) { n++; checkKey(M, k) }
    if (n !== M.uniSize()) fail('union(full) size', M.uniSize() + ' vs ' + n)
  }
  // ── health, from the world's own move table (written apart from the intake's join) ───────────────────
  const oHeld = (g0) => {
    const need = new Map(), done = new Map(), picSeen = new Set(), downs = new Set(), qu = []
    const S = (x) => intake.st.get(x)
    const want = (x, p) => { if (!groups.has(x)) return; if (p <= S(x).pos && S(x).present) return; if ((need.get(x) ?? -1) >= p) return; need.set(x, p); qu.push(x) }
    const visible = (y, c) => { const s = S(y), gr = groups.get(y); if (s.pic) return c <= s.pic.pos ? CARRIES && c > s.pos : c <= gr.hp; return c <= gr.hp }
    const partner = (e) => {
      const m = moves.get(e.mv)
      if (!m) return // a move already closed at the cut: only met when a planted bug sends the cut back ('back')
      if (FIX === 'c') { if (e.kind === 'open') want(m.A, m.fpos); return }
      if (e.kind === 'open') want(m.A, m.fpos)
      else if (e.kind === 'fence') {
        if (m.closeG !== undefined && groups.get(m.closeG).down) downs.add(m.closeG)
        else if (m.closeG !== undefined && visible(m.closeG, m.cpos)) want(m.closeG, m.cpos)
        else if (groups.get(m.B)?.down) downs.add(m.B)
      }
    }
    const s0 = S(g0)
    want(g0, s0.pic ? s0.pic.pos : s0.pos + 1)
    while (qu.length) {
      const x = qu.pop(), gr = groups.get(x), s = S(x), log = gr.log
      if (gr.down) { downs.add(x); continue }
      let from = s.pos
      if (s.pic) {
        if (s.pic.readyAt > step) continue
        if (!picSeen.has(x)) { picSeen.add(x); if (CARRIES) for (let p = s.pos + 1; p <= s.pic.pos; p++) if (log[p - 1].kind !== 'w') partner(log[p - 1]) }
        from = s.pic.pos
      } else if (!s.present) continue
      const lim = Math.min(need.get(x), gr.hp)
      for (let p = Math.max(from, done.get(x) ?? from) + 1; p <= lim; p++) if (log[p - 1].kind !== 'w') partner(log[p - 1])
      done.set(x, Math.max(done.get(x) ?? from, lim))
    }
    return [...downs].sort((a, b) => a - b)
  }
  const checkHealth = () => {
    st.healthChecks++
    const h = intake.health(step)
    for (const [g, s] of intake.st) {
      const gr = groups.get(g)
      if (gr.down) { if (!h.get(g)?.down) fail('health', 'down group ' + g + ' not named'); continue }
      const work = s.pic ? s.pic.readyAt <= step : s.present && s.items.has(s.pos + 1)
      const o = work ? oHeld(g) : []
      const got = h.get(g)?.held ?? []
      if (canon(o) !== canon(got)) fail('health', 'group ' + g + ' held by ' + canon(got) + ', oracle ' + canon(o))
    }
  }
  // ── pictures ────────────────────────────────────────────────────────────────────────────────────────
  const rowsAt = (g, p) => { const gr = groups.get(g); if (p === gr.log.length) return [...gr.p.rows]; const m = new Map(); for (let i = 0; i < p; i++) for (const [k, row] of gr.log[i].delta) { if (row === undefined) m.delete(k); else m.set(k, row) } return [...m] }
  const pictureAt = (g, p) => { const gr = groups.get(g); if (p === gr.log.length) return gr.p.picture(); const q = new Partial(g, { KP: K }); q.takeRows(rowsAt(g, p)); return q.picture() }
  const halvesIn = (g, from, to) => { const out = [], log = groups.get(g).log; for (let p = from + 1; p <= to; p++) if (log[p - 1].kind !== 'w') out.push(log[p - 1]); return out }
  // the moves group g fenced at or before p that the merger has not closed: their rows (fix c)
  const partsAt = (g, p, floor) => {
    const out = []
    for (const m of moves.values()) {
      if (m.A !== g || m.fpos === undefined || m.fpos > p) continue
      if (m.closeKind === 'unfence' && m.cpos <= p) continue
      if (mClosed(m.mv)) continue
      if (MUTATE === 'droprows' && m.closeKind === 'open') continue // planted: copies drop the rows once B opened
      if (floor !== undefined && m.fpos <= floor) continue // planted 'rebuildnomove'
      out.push({ mv: m.mv, rows: m.rows })
    }
    return out
  }
  const noteCase = (g, from, to, rebuild) => { // rule 4's case: the picture passed a half whose partner it does not hold
    const log = groups.get(g).log
    let n = 0, fence = false, open = false, gave = false, any = false
    for (let p = from + 1; p <= to; p++) {
      const e = log[p - 1]
      if (e.kind === 'w' || e.kind === 'unfence') continue
      const m = moves.get(e.mv)
      if (e.kind === 'fence' && m.closeKind === 'unfence' && m.cpos <= to) continue
      any = true
      if (!m.rows.length) continue // a move of empty slots changes no answer
      n++; if (e.kind === 'fence') { fence = true; if (m.giveUp) gave = true } else open = true
    }
    if (any) st.casesAny++
    if (!n) return false
    st.cases++; if (rebuild) st.caseRebuild++; else st.caseTake++
    if (fence) st.caseFence++; if (open) st.caseOpen++; if (gave) st.caseGiveup++; if (n > 1) st.caseMulti++
    return true
  }
  const makePic = (g, p, rebuild) => {
    const s = intake.st.get(g)
    st.pictures++
    st.last = rebuild ? 'rebuild' : 'takeover'
    noteCase(g, s.pos, p, rebuild)
    const carry = CARRIES && !(rebuild && MUTATE === 'rebuildnol')
    let parts = []
    if (FIX === 'c' && MUTATE !== 'nomoverows') parts = partsAt(g, p, rebuild && MUTATE === 'rebuildnomove' ? s.pos : undefined)
    return { pos: p, pic: pictureAt(g, p), halves: carry ? halvesIn(g, s.pos, p) : [], parts, readyAt: step + ri(1, 3) }
  }
  const takeover = (g) => {
    const gr = groups.get(g), s = intake.st.get(g), head = gr.log.length
    st.takeovers++
    let p = MUTATE === 'back' ? ri(Math.max(0, s.pos - 8), head) : RM() < 0.5 ? head : ri(s.pos, head)
    if ((FIX === 'b' || FIX === 'b0') && s.present && !s.pic) {
      if (p - RING <= s.pos) { st.ringHit++; st.last = 'ring'; intake.takeover(g, null); gr.hp = s.pos; return }
      if (MUTATE === 'ringgap') { st.ringHit++; intake.takeover(g, null); intake.skipTo(g, p - RING); gr.hp = p - RING; return }
      st.ringMiss++
    }
    if (!s.present && !s.pic) p = Math.max(p, s.pos) // a group down through a rebuild
    intake.takeover(g, makePic(g, p, !s.present))
    gr.hp = p
  }
  // ── the world's steps ───────────────────────────────────────────────────────────────────────────────
  const commit = () => {
    let k
    for (let i = 0; i < 4 && k === undefined; i++) { const c = keys[Math.floor(R() * KEYS)]; if (owner[slotOfKey.get(c)] >= 0) k = c }
    if (k === undefined) return
    const g = owner[slotOfKey.get(k)], gr = groups.get(g)
    const ks = [k]
    if (R() < 0.05) for (let i = 0; i < 4; i++) { const k2 = keys[Math.floor(R() * KEYS)]; if (owner[slotOfKey.get(k2)] === g && !ks.includes(k2)) ks.push(k2) }
    const changes = []
    for (const k of ks) {
      const prev = gr.p.rows.get(k)
      let next
      const u = R()
      if (!prev || u < 0.4) next = makeRow(k, DOM, R)
      else if (u < 0.7) { next = { ...prev }; const v = genPoints(DOM, R); if (v === undefined) delete next.points; else next.points = v }
      else if (u < 0.8) next = { ...prev, room: genRoom(DOM, R) }
      else next = undefined
      changes.push({ k, prev, next })
    }
    const delta = changes.map((c) => [c.k, c.next])
    gr.log.push({ pos: gr.log.length + 1, kind: 'w', delta, frame: gr.p.apply(changes) })
  }
  const startMove = (A, B, slots, shrink) => {
    const mv = nextMv++
    for (const s of slots) locked[s] = 1
    moves.set(mv, { mv, A, B, slots, state: 'planned', tFence: step + ri(0, 3), cancel: RM() < 0.1, giveUp: RM() < 0.15, shrink })
    st.moves++
  }
  const freeSlots = (gr) => [...gr.slots].filter((s) => !locked[s])
  const pickSlots = (free, n) => { const out = []; while (out.length < n && free.length) out.push(free.splice(Math.floor(RM() * free.length), 1)[0]); return out }
  const moveStep = () => {
    for (const m of moves.values()) {
      if (m.state === 'planned' && step >= m.tFence) {
        if (m.cancel) { m.state = 'cancelled'; for (const s of m.slots) locked[s] = 0; st.cancels++; if (m.shrink) groups.get(m.A).retiring = false; continue }
        const a = groups.get(m.A), ks = []
        for (const s of m.slots) for (const k of slotKeys.get(s) ?? []) if (a.p.rows.has(k)) ks.push(k)
        m.rows = ks.map((k) => [k, a.p.rows.get(k)])
        const frame = a.p.dropRows(ks)
        for (const s of m.slots) { owner[s] = -1; a.slots.delete(s) }
        m.fpos = a.log.length + 1
        a.log.push({ pos: m.fpos, kind: 'fence', delta: ks.map((k) => [k, undefined]), frame, mv: m.mv, A: m.A, B: m.B, rows: m.rows })
        m.state = 'fenced'; m.tClose = step + ri(1, 8); st.fences++
      } else if (m.state === 'fenced' && step >= m.tClose) {
        const to = m.giveUp ? m.A : m.B, gr = groups.get(to)
        const frame = gr.p.takeRows(m.rows)
        for (const s of m.slots) { owner[s] = to; gr.slots.add(s); locked[s] = 0 }
        m.cpos = gr.log.length + 1; m.closeG = to; m.closeKind = m.giveUp ? 'unfence' : 'open'
        gr.log.push({ pos: m.cpos, kind: m.closeKind, delta: m.rows, frame, mv: m.mv, A: m.A, B: m.B, fpos: m.fpos })
        m.state = 'closed'
        if (m.giveUp) { st.giveups++; if (m.shrink) groups.get(m.A).retiring = false } else { st.opens++; st.slotsMoved += m.slots.length }
      }
    }
  }
  const newMove = (elastic) => {
    const live = [...groups].filter(([, gr]) => !gr.retiring && freeSlots(gr).length > 0)
    if (elastic && RM() < 0.5) {
      if (RM() < 0.5 && groups.size < 16) { // grow: half of a group's free slots to a new group
        if (!live.length) return
        const [A, a] = live[Math.floor(RM() * live.length)], free = freeSlots(a)
        if (free.length >= 2) { const B = mkGroup(); startMove(A, B, pickSlots(free, free.length >> 1), false); st.grows++ }
      } else if (live.length > 1) { // shrink: all of a group's slots to another; the group goes once drained
        const i = Math.floor(RM() * live.length), [A, a] = live[i], [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
        if (freeSlots(a).length === a.slots.size && !hasMoves(A)) { a.retiring = true; startMove(A, B, freeSlots(a), true); st.shrinks++ }
      }
      return
    }
    if (live.length < 2) return
    const i = Math.floor(RM() * live.length), [A, a] = live[i], [B] = live[(i + 1 + Math.floor(RM() * (live.length - 1))) % live.length]
    const free = freeSlots(a), n = [1, 8, 64][Math.floor(RM() * 3)]
    if (a.slots.size > 1 && free.length) startMove(A, B, pickSlots(free, Math.min(n, a.slots.size - 1, free.length)), false)
  }
  const hasMoves = (g) => { for (const m of moves.values()) if ((m.A === g || m.B === g) && m.state !== 'cancelled' && !(m.state === 'closed' && taken(m))) return true; return false }
  const taken = (m) => intake.st.get(m.A)?.present && intake.st.get(m.closeG)?.present && intake.st.get(m.A).pos >= m.fpos && intake.st.get(m.closeG).pos >= m.cpos
  const retire = () => {
    syncCut()
    for (const [g, gr] of groups) {
      if (!gr.retiring || gr.slots.size || gr.down || hasMoves(g)) continue
      const s = intake.st.get(g)
      if (!s.present || s.pic || s.pos !== gr.log.length || !intake.serving()) continue
      intake.dropGroup(g)
      for (const [k, l] of tsrc) if (l.some((e) => e[0] === g)) fail('removed group still holds', k)
      groups.delete(g); cutpos.delete(g); st.removed++
    }
    for (const [mv, m] of moves) if (m.state === 'cancelled' || (m.state === 'closed' && taken(m))) moves.delete(mv)
  }
  const deliver = () => {
    for (const [g, gr] of groups) {
      if (gr.down) continue
      let budget = ri(DLO, DHI)
      while (gr.hp < gr.log.length && budget-- > 0) { gr.hp++; intake.deliver(g, gr.log[gr.hp - 1]) }
      st.maxBuf = Math.max(st.maxBuf, intake.st.get(g).items.size)
    }
  }
  // ── the merger's steps and the checks ────────────────────────────────────────────────────────────────
  let sinceFull = 0, gapFrom = -1, gapDown = false
  const afterJoin = (r) => {
    st.joins++
    if (r.pics > 1) st.joinPics2++
    syncCut()
    if (!intake.serving()) return
    if (gapFrom >= 0) { // the new merger serves again
      const gap = step - gapFrom
      if (gapDown) { st.gapDownSum += gap; st.gapDownMax = Math.max(st.gapDownMax, gap); st.gapDownN++ } else { st.gapSum += gap; st.gapMax = Math.max(st.gapMax, gap); st.gapN++ }
      gapFrom = -1; sinceFull = FULL_EVERY
    }
    if (r.pics || ++sinceFull >= FULL_EVERY) { sinceFull = 0; checkFull() } else checkTouched()
  }
  const takeOne = (g) => { const r = intake.take(g, step); if (r.ok) afterJoin(r); return r.ok }
  const mergerStep = () => {
    for (const [g, s] of intake.st) if (s.items.size > LAG) while (s.items.size > LAG / 2 && intake.hasWork(g, step) && takeOne(g));
    const n = ri(0, TAKES)
    for (let i = 0; i < n; i++) {
      const gs = [...intake.st.keys()].filter((g) => intake.hasWork(g, step))
      if (!gs.length) break
      takeOne(gs[Math.floor(RM() * gs.length)])
    }
  }
  const measure = () => { // who waits, and why (not while a new merger is still gathering its parts)
    if (!intake.serving()) return
    let anyDown = false
    for (const [g, s] of intake.st) {
      if (s.down) { anyDown = true; continue }
      if (s.pic && s.pic.readyAt > step) { st.picWait++; continue }
      const nx = s.items.get(s.pos + 1)
      if (!s.pic && (!nx || nx.kind === 'w')) continue
      const pl = intake.plan(g, step)
      if (!pl.ok) { st.waitMove++; if (pl.downs.size) st.held++ }
    }
    if (anyDown && CARRIES && MUTATE !== 'nojoin' && MUTATE !== 'noclosure' && MUTATE !== 'noorder' && MUTATE !== 'nopair') checkHealth()
  }
  const rebuild = () => {
    st.rebuilds++
    const anyDown = [...groups.values()].some((gr) => gr.down)
    if (anyDown) st.rebuildsDown++
    if (gapFrom < 0) { gapFrom = step; gapDown = anyDown } else gapDown = gapDown || anyDown
    for (const mv of intake.closed) oldClosed.add(mv)
    intake.rebuild()
    for (const [g, gr] of groups) { if (gr.down) continue; const p = gr.hp; intake.takeover(g, makePic(g, p, true)); gr.hp = p }
  }
  // ── the run ─────────────────────────────────────────────────────────────────────────────────────────
  try {
    for (step = 1; step <= STEPS; step++) {
      moveStep()
      commit()
      const u = RF()
      if (u < W.move) newMove(W.elastic)
      else if (u < W.move + W.fail) { const gs = [...groups.keys()].filter((g) => !groups.get(g).down); if (gs.length) takeover(gs[Math.floor(RM() * gs.length)]) }
      else if (u < W.move + W.fail + W.out) {
        const gs = [...groups.keys()].filter((g) => !groups.get(g).down)
        if (gs.length) { const g = gs[Math.floor(RM() * gs.length)], gr = groups.get(g); gr.down = true; gr.until = step + W.outLen[0] + Math.floor(RF() * (W.outLen[1] - W.outLen[0] + 1)); intake.setDown(g, true); st.outages++ }
      } else if (u < W.move + W.fail + W.out + W.rebuild) rebuild()
      for (const [g, gr] of groups) if (gr.down && step >= gr.until) { gr.down = false; intake.setDown(g, false); takeover(g) }
      deliver()
      mergerStep()
      measure()
      retire()
    }
    // the end: every outage ends, every move finishes, every frame arrives, and the merger must drain
    for (const [g, gr] of groups) if (gr.down) { gr.down = false; intake.setDown(g, false); takeover(g) }
    for (let guard = 0; ; guard++, step++) {
      if (guard > 20000) fail('stuck', 'drain did not end')
      for (const m of moves.values()) { if (m.state === 'planned') m.tFence = Math.min(m.tFence, step); if (m.state === 'fenced') m.tClose = Math.min(m.tClose, step) }
      moveStep(); deliver()
      let any = false
      for (const g of [...intake.st.keys()]) while (intake.hasWork(g, step) && takeOne(g)) any = true
      retire()
      const pending = [...moves.values()].some((m) => m.state === 'planned' || m.state === 'fenced')
      const undelivered = [...groups.values()].some((gr) => gr.hp < gr.log.length)
      const pics = [...intake.st.values()].some((s) => s.pic)
      const left = [...intake.st].some(([g, s]) => s.items.size || s.pic)
      if (!pending && !undelivered && !pics && !left) break
      if (!any && !pending && !undelivered && !pics && left) fail('stuck', 'units left that cannot be taken')
      if (!any && !pending && !undelivered && pics && guard > 10) fail('stuck', 'pictures that cannot be installed')
    }
    if (!intake.serving()) fail('stuck', 'not serving at the end')
    syncCut(); checkFull()
  } catch (e) { if (!(e instanceof Stop)) throw e }
  st.groupsAtEnd = groups.size
  return st
}

const SUM = ['joins', 'checks', 'full', 'moves', 'cancels', 'fences', 'opens', 'giveups', 'slotsMoved', 'grows', 'shrinks', 'removed', 'takeovers', 'outages', 'rebuilds', 'rebuildsDown',
  'casesAny', 'gapSum', 'gapDownSum', 'gapN', 'gapDownN', 'ringHit', 'ringMiss', 'pictures', 'cases', 'caseTake', 'caseRebuild', 'caseFence', 'caseOpen', 'caseGiveup', 'caseMulti', 'joinPics2', 'waitMove', 'held', 'picWait', 'healthChecks']
const tot = Object.fromEntries(SUM.map((k) => [k, 0]))
let failed = 0, failedCase = 0, failedNoCase = 0, seedsCase = 0, seedsAny = 0, failedNoAny = 0, gapMax = 0, gapDownMax = 0, maxBuf = 0
const kinds = {}, after = {}, firsts = []
const t0 = Date.now()
for (let s = SEED0; s < SEED0 + SEEDS; s++) {
  const st = runSeed(s)
  for (const k of SUM) tot[k] += st[k]
  gapMax = Math.max(gapMax, st.gapMax); gapDownMax = Math.max(gapDownMax, st.gapDownMax); maxBuf = Math.max(maxBuf, st.maxBuf)
  if (st.cases) seedsCase++
  if (st.casesAny) seedsAny++
  if (st.mismatches) {
    failed++; if (st.cases) failedCase++; else failedNoCase++; if (!st.casesAny) failedNoAny++
    after[st.first.after] = (after[st.first.after] ?? 0) + 1
    const kind = st.first.what.split(/[ (]/)[0]; kinds[kind] = (kinds[kind] ?? 0) + 1
    if (firsts.length < 3) firsts.push({ seed: s, ...st.first })
  }
  if (arg('trace', '') !== '' || process.argv.includes('--trace')) console.error(JSON.stringify(st))
}
console.log(JSON.stringify({ world: WORLD, fix: FIX, mutate: MUTATE || 'none', ring: FIX === 'b' || FIX === 'b0' ? RING : undefined, seeds: SEEDS, steps: STEPS, keys: KEYS,
  failed, seedsWithCase: seedsCase, failedWithCase: failedCase, failedNoCase, seedsWithAnyCase: seedsAny, failedNoAnyCase: failedNoAny, kinds, after, ...tot, gapMax, gapDownMax, maxBuf, ms: Date.now() - t0, firsts }))
