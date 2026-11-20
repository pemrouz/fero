// B4, XB-11: a live lookup join (src/lookup.mjs). Left: 50 rows { sku } held here (a data source fed by the left
// resource's commits). Right: 1,000 product rows in another resource, with its own commits (changes and removes,
// and rows coming back). The process holds one link per sku the left rows name: a new sku costs one trip (its
// picture arrives 1 to 4 steps later, at the right side's position then); after that the link receives that
// sku's records in order, each 0 to 3 steps late. The oracle, after every step (a commit on either side, a
// picture or a record arriving): for every left row, `other` equals the right row for row.sku at this process's
// position for that sku (from the right side's own history), null if no such row there, and undefined only
// before the sku's first picture; open links (count > 0) equal the distinct skus the left rows name; after the
// view ends, 0 links. Planted (MUTATE): reverse, count, undef (see src/lookup.mjs).
//   node b4-lookup.mjs <seeds> <steps>
import { rng, canon, applyRec } from '../src/lib.mjs'
import { D, laneOf } from '../src/ops.mjs'
import { Lookup } from '../src/lookup.mjs'

const SEEDS = +(process.argv[2] ?? 1000), STEPS = +(process.argv[3] ?? 400)
const MUTATE = process.env.MUTATE ?? ''
const NL = 50, NR = 1000
const T = { seeds: 0, checks: 0, unequal: 0, linkChecks: 0, linkBad: 0, endBad: 0, seedsFailed: 0, trips: 0, newKeys: 0, closedAfterLinger: 0, rightCommits: 0, leftCommits: 0, pictures: 0, records: 0, undefinedSeen: 0, nullSeen: 0 }
let first = null

function runSeed(seed) {
  const R = rng(seed * 131 + 9)
  let step = 0
  // the right resource: rows, and per key its history [(pos, row | null)]
  const right = new Map(), hist = new Map()
  let rpos = 0
  const skus = Array.from({ length: NR }, (_, i) => 's' + i)
  const setRight = (k, row) => { rpos++; if (row === null) right.delete(k); else right.set(k, row); let h = hist.get(k); if (!h) hist.set(k, (h = [])); h.push([rpos, row]) }
  for (const k of skus) if (R() < 0.9) setRight(k, { id: k, title: 't' + Math.floor(R() * 100), price: Math.floor(R() * 50) })
  const rightAt = (k, p) => { const h = hist.get(k); let v = null; if (h) for (const [q, row] of h) { if (q > p) break; v = row } return v }
  // the network: links' pictures and records, with delays
  const inflight = [] // { at: step, kind, ok, pos, row }
  const linkPos = new Map() // ok -> this process's position for that sku (the last picture or record applied)
  const opened = new Set()
  const net = {
    now: () => step,
    open: (ok) => { opened.add(ok); inflight.push({ at: step + 1 + Math.floor(R() * 4), kind: 'picture', ok }) },
    close: (ok) => { opened.delete(ok); linkPos.delete(ok); for (const m of inflight) if (m.ok === ok) m.dead = true },
  }
  // the left side
  const left = D.$({}), lane = laneOf(left), leftTruth = new Map()
  const hot = skus.slice(0, 120) // left rows name a hot subset, so several left rows share a sku
  const lk = Array.from({ length: NL }, (_, i) => 'o' + i)
  for (const k of lk) { const rec = { type: 1, key: [], at: k, value: { id: k, sku: hot[Math.floor(R() * hot.length)], n: 1 } }; lane([rec]); applyRec(leftTruth, rec) }
  const J = new Lookup(left, 'sku', net, { linger: 5, mutate: MUTATE })
  let bad = 0
  const check = () => {
    const out = J.out[D.node]
    let ok = out.rowCount() === leftTruth.size
    let ex = ''
    for (const [k, row] of leftTruth) {
      const got = out.hasRow(k) ? out.rowAt(k) : undefined
      let want
      if (!linkPos.has(row.sku)) want = undefined // its first picture is on its way
      else want = rightAt(row.sku, linkPos.get(row.sku))
      if (got === undefined || canon(got.row) !== canon(row) || canon(got.other) !== canon(want)) { ok = false; ex = `${k} sku ${row.sku}: got ${canon(got?.other)} want ${canon(want)}`; break }
      if (got.other === undefined) T.undefinedSeen++; else if (got.other === null) T.nullSeen++
    }
    T.checks++
    if (!ok) { T.unequal++; bad++; if (first === null) first = `seed ${seed} step ${step}: ${ex}` }
    const named = new Set([...leftTruth.values()].map((r) => r.sku))
    T.linkChecks++
    if (J.openLinks() !== named.size || [...named].some((s) => !J.links.has(s) || J.links.get(s).count === 0)) { T.linkBad++; bad++; if (first === null) first = `seed ${seed} step ${step}: links ${J.openLinks()} vs named ${named.size}` }
  }
  check()
  for (step = 1; step <= STEPS; step++) {
    const u = R()
    if (u < 0.35) { // a left commit: a sku change, a row removed or added back, another field
      const k = lk[Math.floor(R() * lk.length)]
      let rec
      if (!leftTruth.has(k)) rec = { type: 1, key: [], at: k, value: { id: k, sku: hot[Math.floor(R() * hot.length)], n: 1 } }
      else if (R() < 0.55) rec = { type: 0, key: [k, 'sku'], value: hot[Math.floor(R() * hot.length)] }
      else if (R() < 0.6) rec = { type: 0, key: [k, 'n'], value: Math.floor(R() * 9) }
      else rec = { type: 2, key: [k] }
      lane([rec]); applyRec(leftTruth, rec)
      T.leftCommits++
    } else if (u < 0.7) { // a right commit on a hot sku: a change, a remove, or a row coming back
      const k = R() < 0.9 ? hot[Math.floor(R() * hot.length)] : skus[Math.floor(R() * NR)]
      const row = right.has(k) && R() < 0.25 ? null : { id: k, title: 't' + Math.floor(R() * 100), price: Math.floor(R() * 50) }
      setRight(k, row)
      T.rightCommits++
      if (opened.has(k)) inflight.push({ at: step + Math.floor(R() * 4), kind: 'record', ok: k, pos: rpos, row })
    }
    // deliveries due now, in order per sku
    inflight.sort((a, b) => a.at - b.at || (a.pos ?? 0) - (b.pos ?? 0))
    while (inflight.length && inflight[0].at <= step) {
      const m = inflight.shift()
      if (m.dead) continue
      if (m.kind === 'picture') { linkPos.set(m.ok, rpos); J.picture(m.ok, right.has(m.ok) ? right.get(m.ok) : null); T.pictures++; for (const x of inflight) if (x.ok === m.ok && x.kind === 'record' && x.pos <= rpos) x.dead = true }
      else { if (!linkPos.has(m.ok) || m.pos <= linkPos.get(m.ok)) continue; linkPos.set(m.ok, m.pos); J.record(m.ok, m.row); T.records++ }
      check()
    }
    J.tick()
    check()
  }
  T.trips += J.trips; T.closedAfterLinger += J.closed
  J.end()
  if (J.links.size !== 0 || opened.size !== 0) { T.endBad++; bad++ }
  T.seeds++
  if (bad) T.seedsFailed++
}

const t0 = performance.now()
for (let s = 1; s <= SEEDS; s++) runSeed(s)
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'B4+XB-11', bench: 'lookup', planted: MUTATE || null, seeds: SEEDS, steps: STEPS, leftRows: NL, rightRows: NR, ...T, seconds: Math.round(performance.now() - t0) / 1000, first }))
