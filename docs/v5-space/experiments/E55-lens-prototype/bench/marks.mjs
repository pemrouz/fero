// Claim 21: marks from app code: `totals.data[u].set(op.incr(c), { from: e })` sent without waiting.
//   node marks.mjs sim [seeds] [cap] [records]
//       A seeded stand-in for E-30's model (NOT that model: no Raft, no lost log tails), on lens.mjs's server
//       Resource as the output's leader. The leader keeps one mark per (reader name, output slot); a marked write
//       lands with its mark in one data commit; a marked write at or below the slot's mark is skipped and answered
//       as done. This is the second form of the sim (review F2). The first form (results/sims-first-pass.jsonl and
//       the first 'marks-sim' line of results/sims.jsonl) had queues with no limit, lost only whole queue tails,
//       and sent a bare mark to every slot every 5 records, which LENS.md's four lines do not. Here:
//         - no bare marks: only the four lines' writes;
//         - a cap on waiting writes (API 3.6: 512). Past it `set()` is refused `backpressure` on the client: the
//           write is never sent and gets no number, so no leader can see that it is missing;
//         - the source arrives in bursts (a reader catching up), so the cap is reached;
//         - a crash loses a random TAIL of each of the deriver's queues; a slot move loses a random HEAD of each
//           queue to that slot and delivers the rest to the new place: lost, then a later write delivered;
//         - the leader's order rule (LENS 2.8 item 3): per (writer, slot) it takes write n only after n-1; a later
//           one is refused `gap`;
//         - two derivers under one name, a write refused by its condition (the mark still moves).
//       Variants (each a row of the result):
//         as-written   the four lines: a backpressure refusal is ignored and the loop goes on
//         block        a marked write that fails on the client blocks later marked writes to that slot, until the
//                      loop is started again
//         pace         changes() stops yielding while the target's queue is full: no backpressure refusal happens
//         pace-nogap   pace, but the leader does not check order: shows the order rule is needed
//         nomarks      pace, but a slot move does not carry its marks (the first form's control)
//       After the faults, the deriver is restarted from the marks and run with no faults, up to 10 times, until a
//       pass loses nothing. Check: every output equals f(source) exactly: nothing lost, nothing twice.
//   node marks.mjs rate          over a real MessagePort to a server worker that answers writes at a group commit
//                                every 4 ms (a disk sync stand-in): records a second, awaited loop vs not awaited.
import { fero } from '../proto/lens.mjs'
import { rng, out, r1 } from './common.mjs'
import { startServer, PortTransport } from '../proto/net.mjs'

const PART = process.argv[2]

const VARIANTS = {
  'as-written': { bp: 'ignore', pace: false, gap: true, marksMove: true },
  block: { bp: 'block', pace: false, gap: true, marksMove: true },
  pace: { bp: 'ignore', pace: true, gap: true, marksMove: true },
  'pace-nogap': { bp: 'ignore', pace: true, gap: false, marksMove: true },
  nomarks: { bp: 'ignore', pace: true, gap: true, marksMove: false },
}
function sim(seed, variant, CAP, NREC) {
  const V = VARIANTS[variant]
  const r = rng(seed), chance = (p) => r() % 1000 < p * 1000, pick = (a) => a[r() % a.length]
  const SLOTS = 4, USERS = 8
  const slotOf = (u) => u % SLOTS
  // the source log: record i adds cents to user u; some records carry a condition that refuses
  const src = Array.from({ length: NREC }, (_, i) => ({ seq: i + 1, u: r() % USERS, c: 1 + (r() % 9), refuse: chance(0.1) }))
  const want = new Map(); for (const x of src) if (!x.refuse) want.set(x.u, (want.get(x.u) ?? 0) + x.c)
  // the output's leaders: one server Resource per slot place; the marks and the order table beside the rows
  const place = Array.from({ length: SLOTS }, () => ({ res: fero('totals', { data: {} }), marks: new Map(), next: new Map() }))
  const st = { applied: 0, refused: 0, skipped: 0, gap: 0, backpressure: 0, blockedDrops: 0, lostInFlight: 0, lostThenDelivered: 0, moves: 0, crashes: 0, twins: 0, restarts: 0, maxWaiting: 0 }
  const leaderWrite = (slot, m) => {
    const P = place[slot]
    if (V.gap) { // order per (writer, slot): n only after n-1
      const exp = P.next.get(m.w) ?? 1
      if (m.n !== exp) return 'gap'
      P.next.set(m.w, exp + 1)
    }
    if (m.seq <= (P.marks.get('totals') ?? 0)) return 'skipped' // at or below the mark: answered as done
    let outcome = 'applied'
    P.res.eng.rt.batch(() => { // the write and its mark: one commit
      if (m.refuse) outcome = 'refused'
      else P.res.set(['u' + m.u], (v) => (v ?? 0) + m.c)
      P.marks.set('totals', m.seq)
    })
    return outcome
  }
  const queues = []
  let dirty = false // something was lost or refused since the last restart
  const fail = (d, slot) => { dirty = true; if (V.bp === 'block') d.blocked[slot] = true }
  const deliverOne = () => {
    const live = queues.filter((q) => q.items.length)
    if (!live.length) return false
    const q = pick(live)
    const m = q.items.shift(); q.d.waiting--
    const o = leaderWrite(q.slot, m)
    if (o === 'gap') { st.gap++; fail(q.d, q.slot) } else st[o]++
    return true
  }
  // the cursor totals.marks('totals') gives: the lowest mark over the output slots (no bare marks, so a slot that
  // got no output yet keeps the cursor at the start)
  const marksLow = () => Math.min(...place.map((P) => P.marks.get('totals') ?? 0))
  let derivers = [], ids = 0
  const startDeriver = () => {
    const d = { id: ++ids, pos: marksLow(), dead: false, waiting: 0, blocked: [], n: new Array(SLOTS).fill(0) }
    d.qs = Array.from({ length: SLOTS }, (_, s) => { const q = { slot: s, items: [], d }; queues.push(q); return q })
    derivers.push(d); st.restarts++
  }
  // the four lines: for await (const e of changes) totals.data[u].set(incr, { from: e })   (not awaited)
  const stepDeriver = (d) => {
    if (d.dead || d.pos >= NREC) return false
    if (V.pace && d.waiting >= CAP) return false // the fix "pace": changes() does not yield while the queue is full
    const x = src[d.pos++], s = slotOf(x.u)
    if (d.blocked[s]) { st.blockedDrops++; return true } // the fix "block": refused here until the loop restarts
    if (d.waiting >= CAP) { st.backpressure++; fail(d, s); return true } // refused `backpressure`: never sent, no number
    d.qs[s].items.push({ w: d.id, n: ++d.n[s], seq: x.seq, u: x.u, c: x.c, refuse: x.refuse })
    if (++d.waiting > st.maxWaiting) st.maxWaiting = d.waiting
    return true
  }
  const burst = (d) => { const k = chance(0.25) ? 1 + (r() % (2 * CAP)) : 1; for (let i = 0; i < k; i++) if (!stepDeriver(d)) break }
  startDeriver()
  const FAULT_STEPS = NREC * 8
  for (let step = 0; step < FAULT_STEPS; step++) {
    const a = r() % 100
    const liveD = derivers.filter((x) => !x.dead)
    if (a < 30) { if (liveD.length) burst(pick(liveD)) }
    else if (a < 88) deliverOne()
    else if (a < 91) { // a crash: a random tail of each queue never left; a new life restarts from the marks
      const d = liveD[0]
      if (d) { d.dead = true; st.crashes++; for (const q of d.qs) if (q.items.length && chance(0.5)) { const keep = r() % (q.items.length + 1); st.lostInFlight += q.items.length - keep; q.items.length = keep } startDeriver() }
    } else if (a < 93 && liveD.length < 2) { st.twins++; startDeriver() } // two readers of one name
    else if (a < 97) { // an output slot moves: rows, marks and the order table to a new place. Writes in flight to
      // the old place are lost (a head of each queue); the writes behind them reach the new place
      const s = r() % SLOTS, old = place[s]
      place[s] = { res: fero('totals', { data: Object.fromEntries(old.res.eng.src.snapshot()) }), marks: V.marksMove ? new Map(old.marks) : new Map(), next: new Map(old.next) }
      for (const q of queues) if (q.slot === s && q.items.length && chance(0.5)) {
        const lose = 1 + (r() % q.items.length)
        q.items.splice(0, lose); q.d.waiting -= lose; st.lostInFlight += lose
        if (q.items.length) st.lostThenDelivered++
        if (!q.d.dead) fail(q.d, s)
      }
      st.moves++
    } else if (liveD.length && liveD.every((x) => x.pos >= NREC) && dirty && queues.every((q) => !q.items.length)) {
      for (const d of derivers) d.dead = true; dirty = false; startDeriver() // the app restarts a loop that saw a failure
    }
  }
  // calm: restart from the marks and run with no faults, until a pass loses nothing (at most 10 passes)
  let passes = 0
  for (; passes < 10; passes++) {
    while (deliverOne());
    for (const d of derivers) d.dead = true
    dirty = false
    startDeriver()
    const d = derivers[derivers.length - 1]
    while (d.pos < NREC) { if (chance(0.4)) burst(d); else if (!deliverOne() && d.waiting >= CAP) break }
    while (deliverOne());
    if (!dirty) { passes++; break }
  }
  // the outputs against f(source)
  let lost = 0, doubled = 0
  for (let u = 0; u < USERS; u++) {
    const got = place[slotOf(u)].res.eng.src.get('u' + u) ?? 0, w = want.get(u) ?? 0
    if (got < w) lost++; if (got > w) doubled++
  }
  return { lost, doubled, passes, cleanEnd: !dirty, ...st }
}

if (PART === 'sim') {
  const SEEDS = +(process.argv[3] ?? 1000), CAP = +(process.argv[4] ?? 8), NREC = +(process.argv[5] ?? 60)
  const res = {}
  for (const variant of Object.keys(VARIANTS)) {
    const t = { seeds: 0, badSeeds: 0, lostOutputs: 0, doubledOutputs: 0, notCleanAtEnd: 0, maxWaiting: 0 }
    for (let s = 1; s <= SEEDS; s++) {
      const x = sim(s, variant, CAP, NREC)
      t.seeds++; if (x.lost + x.doubled) t.badSeeds++
      t.lostOutputs += x.lost; t.doubledOutputs += x.doubled; if (!x.cleanEnd) t.notCleanAtEnd++
      for (const k of ['applied', 'refused', 'skipped', 'gap', 'backpressure', 'blockedDrops', 'lostInFlight', 'lostThenDelivered', 'moves', 'crashes', 'twins', 'restarts']) t[k] = (t[k] ?? 0) + x[k]
      t.maxWaiting = Math.max(t.maxWaiting, x.maxWaiting)
    }
    res[variant] = t
  }
  out({ claim: 21, bench: 'marks-sim-2', cap: CAP, records: NREC, ...res })
}

if (PART === 'rate') {
  // a group commit every 4 ms: a write is answered at the first sync after it (a disk sync stand-in)
  const seed = {}
  const server = await startServer({ depth: 1, seed, syncMs: 4 })
  const tr = new PortTransport(server); tr.bind({})
  const N1 = 500, N2 = 50000
  let t0 = performance.now()
  for (let i = 0; i < N1; i++) await tr.write(['u' + (i % 100)], { n: i, from: i })
  const awaited = N1 / ((performance.now() - t0) / 1000)
  t0 = performance.now()
  const ps = []
  for (let i = 0; i < N2; i++) ps.push(tr.write(['v' + (i % 100)], { n: i, from: i }))
  await Promise.all(ps)
  const pipelined = N2 / ((performance.now() - t0) / 1000)
  out({ claim: 21, bench: 'marks-rate', syncMs: 4, awaitedPerS: Math.round(awaited), notAwaitedPerS: Math.round(pipelined), ratio: r1(pipelined / awaited) })
  await server.stop(); process.exit(0)
}
