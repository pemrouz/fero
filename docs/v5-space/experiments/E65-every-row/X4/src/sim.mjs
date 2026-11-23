// E-65 X4: the seeded run. One resource of S slots over G groups. Each step one commit (insert, update, remove
// a row's number; some values are not numbers), a paired slot move, or a group resync. Every group queues one
// delivery per commit, carrying the field's old and new value; a move is one delivery in each of its two groups'
// queues, carrying the slot's values. The asker takes 0 to 3 deliveries a step from random groups.
// The oracle: the rows of exactly the commits the asker took (its cut), folded by commit order on their own, in a
// sorted array. After every delivery: the count must match; the approximate value at every checked rank must be
// within the relative error a of the oracle's; the exact median (when every group's band is in) must equal the
// oracle's, and so must a random rank inside the band. Every 250 steps, one-time exact reads of four ranks at the groups' heads.
// Planted bugs (--mutate): nopair, resyncadd, noremove, bandold, picadd, negbucket, infbucket, rank7, nooff.
import { mapping, rankable, type7, Hist } from './dd.mjs'
import { Asker } from './asker.mjs'
import { readRank } from './onetime.mjs'
import { rng, maker, DISTS } from './rng.mjs'

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const SEEDS = +arg('seeds', 200), SEED0 = +arg('seed0', 1), STEPS = +arg('steps', 3000), BUG = arg('mutate', '')
const ALPHA = +arg('alpha', 0.01), S = +arg('S', 64)
const QS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]

function lb(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m } return lo }
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b))

function runSeed(seed) {
  const r = rng(seed * 7919 + 13), dist = DISTS[seed % DISTS.length], G = 2 + r.int(7), mk = maker(r, dist)
  const m = mapping(ALPHA, BUG)
  const owner = Array.from({ length: S }, (_, s) => s % G)
  const rows = new Map() // head: key -> { s, v }
  const q = Array.from({ length: G }, () => [])
  const orows = new Map(), osorted = [] // the oracle at the asker's cut
  const A = new Asker(m, G, BUG)
  const st = { seed, dist, G, commits: 0, moves: 0, resyncs: 0, takes: 0, checks: 0, exactChecks: 0, rebands: 0, readyTakes: 0, onetime: 0, onetimeTrips: 0, onetimeSplit: 0, fail: null }
  let seq = 0, mvid = 0, keyN = 0
  const fail = (why) => { if (!st.fail) st.fail = why }

  const oTake = (d) => {
    const p = orows.get(d.k)
    if (p && p.seq > d.seq) return
    if (p && rankable(p.v)) osorted.splice(lb(osorted, p.v === 0 ? 0 : p.v), 1)
    if (d.rm) orows.delete(d.k); else { orows.set(d.k, { seq: d.seq, v: d.n }); if (rankable(d.n)) { const v = d.n === 0 ? 0 : d.n; osorted.splice(lb(osorted, v), 0, v) } }
  }
  const apply = (g, d, half = false) => {
    if (d.t === 'w') { A.delta(g, d.o, d.n); oTake(d) }
    else if (d.t === 'mv') { for (const v of d.vals) A.val(g, v, d.side) }
    else if (d.t === 'pic') A.installBand(g, d.range, d.vals)
  }
  const skipping = new Set()
  const takeFrom = (g) => {
    const d = q[g][0]
    if (!d) return false
    if (d.t === 'mv') {
      const p = d.side < 0 ? d.g2 : d.g1
      if (BUG === 'nopair') { q[g].shift(); apply(g, d); return true }
      if (skipping.has(p)) { const i = q[p].findIndex((x) => x.t === 'mv' && x.id === d.id); q[p].splice(i, 1); q[g].shift(); apply(g, d); return true }
      const e = q[p][0]
      if (e && e.t === 'mv' && e.id === d.id) { q[g].shift(); q[p].shift(); apply(g, d); apply(p, e); return true }
      return takeFrom(p)
    }
    q[g].shift(); apply(g, d); return true
  }
  const headVals = (g) => { const out = []; for (const x of rows.values()) if (owner[x.s] === g && rankable(x.v)) out.push(x.v); return out }
  const inRange = (range, v) => { const b = m.bid(v); return b >= range[0] && b <= range[1] }
  const askBand = () => {
    const range = A.rangeFor(0.5)
    if (range === null) return
    A.setWant(range); st.rebands++
    for (let g = 0; g < G; g++) q[g].push({ t: 'pic', range, vals: headVals(g).filter((v) => inRange(range, v)) })
  }
  const resync = (g) => {
    st.resyncs++
    skipping.add(g)
    for (const d of [...q[g]]) {
      if (d.t !== 'mv' || !q[g].includes(d)) continue
      const p = d.side < 0 ? d.g2 : d.g1
      if (q[p].some((x) => x.t === 'mv' && x.id === d.id)) { // (with nopair the other half may be taken already)
        while (!(q[p][0] && q[p][0].t === 'mv' && q[p][0].id === d.id)) takeFrom(p)
        const e = q[p].shift(); apply(p, e)
      }
      q[g].splice(q[g].indexOf(d), 1)
    }
    for (const d of q[g]) if (d.t === 'w') oTake(d)
    q[g] = []
    skipping.delete(g)
    const vals = headVals(g)
    A.resync(g, vals, A.want)
  }
  const check = () => {
    st.checks++
    const n = osorted.length
    if (A.all.n !== n) return fail(`count ${A.all.n} != ${n}`)
    if (n === 0) return
    for (const qq of QS) {
      const lo = Math.floor((n - 1) * qq)
      for (const rk of lo + 1 < n ? [lo, lo + 1] : [lo]) {
        const e = osorted[rk], a = A.all.atRank(rk)
        const ok = Number.isFinite(e) ? Math.abs(a - e) <= ALPHA * Math.abs(e) * (1 + 1e-9) : a === e
        if (!ok) return fail(`approx q=${qq} rank ${rk}: ${a} vs ${e}`)
      }
    }
    if (!A.ready()) return
    st.readyTakes++
    const ex = A.exact(0.5)
    if (ex === undefined) { if (A.per.every((P) => P.range === A.want)) askBand(); return }
    st.exactChecks++
    const want = type7(n, 0.5, (i) => osorted[i])
    if (!same(ex, want)) return fail(`exact median ${ex} vs ${want}`)
    const below = A.all.below(A.want[0])
    if (below !== A.belowN) return fail(`below ${A.belowN} vs ${below}`)
    if (A.bandN > 0) { const rk = below + r.int(A.bandN); const x = A.exactAt(rk); if (!same(x, osorted[rk])) return fail(`exact rank ${rk}: ${x} vs ${osorted[rk]}`) }
  }
  const onetime = () => {
    const groups = []
    for (let g = 0; g < G; g++) { const vals = headVals(g); const hist = new Hist(m); for (const v of vals) hist.add(v, 1); groups.push({ vals, hist }) }
    const all = []
    for (const x of rows.values()) if (rankable(x.v)) all.push(x.v === 0 ? 0 : x.v)
    all.sort((a, b) => a - b)
    if (!all.length) return
    st.onetime++
    for (const rk of [Math.floor((all.length - 1) / 2), r.int(all.length), r.int(all.length), r.int(all.length)]) {
      const res = readRank(groups, rk, m, { cap: 1, bug: BUG })
      if (!res || !same(res.v === 0 ? 0 : res.v, all[rk])) return fail(`onetime rank ${rk}: ${res && res.v} vs ${all[rk]}`)
      st.onetimeTrips = Math.max(st.onetimeTrips, res.trips); if (res.trips > 2) st.onetimeSplit++
    }
  }

  for (let step = 0; step < STEPS && !st.fail; step++) {
    const t = step / STEPS, p = r()
    if (p < 0.004 && G > 1) {
      const s = r.int(S), g1 = owner[s]; let g2 = r.int(G - 1); if (g2 >= g1) g2++
      const vals = []; for (const x of rows.values()) if (x.s === s && rankable(x.v)) vals.push(x.v)
      const id = ++mvid
      q[g1].push({ t: 'mv', id, side: -1, g1, g2, vals }); q[g2].push({ t: 'mv', id, side: +1, g1, g2, vals })
      owner[s] = g2; st.moves++
    } else if (p < 0.005) resync(r.int(G))
    else {
      let k, o, x = r()
      if (rows.size < 50 || x < 0.25) { k = `k${keyN++}`; o = undefined }
      else { const i = r.int(rows.size); k = [...rows.keys()][i]; o = rows.get(k).v }
      const rm = o !== undefined && r() < 0.12
      const s = o !== undefined ? rows.get(k).s : r.int(S)
      const n = rm ? undefined : mk(t, true)
      if (rm) rows.delete(k); else rows.set(k, { s, v: n })
      q[owner[s]].push({ t: 'w', seq: ++seq, k, o, n, rm })
      st.commits++
    }
    const takes = r.int(4)
    for (let i = 0; i < takes && !st.fail; i++) { const g = r.int(G); if (takeFrom(g)) { st.takes++; check() } }
    for (let g = 0; g < G && !st.fail; g++) while (q[g].length > 100 && !st.fail) { takeFrom(g); st.takes++; check() }
    if (A.want === null && !st.fail) askBand()
    if (step % 250 === 249 && !st.fail) onetime()
  }
  for (let g = 0; g < G && !st.fail; g++) while (q[g].length && !st.fail) { takeFrom(g); st.takes++; check() }
  if (!st.fail) onetime()
  return st
}

const t0 = Date.now()
const tot = { seeds: 0, failed: 0, commits: 0, moves: 0, resyncs: 0, takes: 0, checks: 0, exactChecks: 0, rebands: 0, readyTakes: 0, onetime: 0, onetimeSplit: 0, maxOnetimeTrips: 0 }
const fails = [], byDist = {}
for (let s = SEED0; s < SEED0 + SEEDS; s++) {
  const st = runSeed(s)
  tot.seeds++
  for (const k of ['commits', 'moves', 'resyncs', 'takes', 'checks', 'exactChecks', 'rebands', 'readyTakes', 'onetime', 'onetimeSplit']) tot[k] += st[k]
  tot.maxOnetimeTrips = Math.max(tot.maxOnetimeTrips, st.onetimeTrips)
  byDist[st.dist] ??= { seeds: 0, failed: 0 }; byDist[st.dist].seeds++
  if (st.fail) { tot.failed++; byDist[st.dist].failed++; if (fails.length < 3) fails.push({ seed: s, dist: st.dist, G: st.G, why: st.fail }) }
}
console.log(JSON.stringify({ part: 'sim', mutate: BUG || 'none', alpha: ALPHA, S, steps: STEPS, ...tot, byDist, fails, secs: (Date.now() - t0) / 1000 }))
