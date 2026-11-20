// Probe 2 (I12): `for await` over connect. Timed: run each part alone under the timing lock, three runs.
//   node --expose-gc --experimental-strip-types foreach.mjs grow <merge|every> <row|whole> [seconds] [rate] [slowMs]
//   node --expose-gc --experimental-strip-types foreach.mjs cost
// grow  a writer makes `rate` commits a second (default 10,000) for `seconds` (default 5) on a server resource of
//       1,000 rows (E-55's row); a for-await loop over connect() takes `slowMs` (default 1 ms, a timer: I/O-like work)
//       per turn, so it is about 10 times slower than the writes. merge (no `from`): each turn gets the newest state
//       and one merged change per row since its last turn (the live state's rule). every (`from: 'now'`): each turn
//       gets the next commit, and the commits it has not taken wait here in order (the log's rule). Every 100 ms: the
//       waiting size and the heap. At the end: the waiting size, the heap growth (after a full collection, with the
//       waiting commits still held), commits written, commits the loop has seen.
// cost  ns per commit of one link on the whole resource (10,000 rows, field writes spread over rows), the ways
//       interleaved round by round (each in its own resource made up front), the median of 7 rounds:
//       none (no link), callback (fn(state, commit) reads nothing), callback reading commit.changes and each prev,
//       every-burst (a for-await loop, every commit; the writer writes 100 then waits for the loop to drain),
//       merge-burst (the same, merged), every-pingpong (one write, then wait for the loop's turn), and the writer's own
//       wait with no link (none-pingpong: one write, then await one resolved promise).
import { fero } from '../../../E55-lens-prototype/proto/lens.mjs'
import { row, seedRows, gc, now, med, r1 } from '../../../E55-lens-prototype/bench/common.mjs'
import '../proto/connect.mjs'

const out = (o) => console.log(JSON.stringify({ exp: 'E-56', probe: 2, node: process.version, ...o }))
const PART = process.argv[2]
const heap = () => process.memoryUsage().heapUsed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (PART === 'grow') {
  const mode = process.argv[3], shape = process.argv[4]
  const SECS = +(process.argv[5] ?? 5), RATE = +(process.argv[6] ?? 10000), SLOW = +(process.argv[7] ?? 1)
  const ROWS = 1000
  const srv = fero('s', { data: seedRows(ROWS) })
  srv.eng.promote()
  const lens = shape === 'row' ? srv.data.k7 : srv.data
  const h = lens.connect(mode === 'every' ? { from: 'now' } : undefined)
  await h.ready
  const it = h[Symbol.asyncIterator]()
  let items = 0, covered = 0, stop = false, maxSize = 0
  const loop = (async () => {
    for await (const { commit } of it) {
      items++
      if (!commit.first) covered += commit.commits ?? 1
      if (stop) break
      await sleep(SLOW)
    }
  })()
  gc(); await sleep(20); gc()
  const h0 = heap()
  const t0 = performance.now()
  let written = 0, w = 0
  const write = () => { const i = shape === 'row' ? 7 : (w * 7919) % ROWS; w++; srv.set(['k' + i, 'n'], w) }
  const samples = []
  let lastSample = t0
  await new Promise((done) => {
    const iv = setInterval(() => {
      const t = performance.now()
      const due = Math.min(Math.floor(((t - t0) * RATE) / 1000), SECS * RATE)
      while (written < due) { write(); written++ }
      const sz = it.size; if (sz > maxSize) maxSize = sz
      if (t - lastSample >= 100) { lastSample = t; samples.push({ ms: Math.round(t - t0), waiting: sz, heapMB: Math.round(heap() / 1e5) / 10 }) }
      if (written >= SECS * RATE) { clearInterval(iv); done() }
    }, 1)
  })
  const elapsed = performance.now() - t0
  const waitingAtEnd = it.size, itemsAtEnd = items, coveredAtEnd = covered
  gc(); await sleep(5); gc()
  const growth = heap() - h0
  stop = true
  h.disconnect()
  await loop
  out({ part: 'grow', mode, shape, rows: ROWS, rate: RATE, seconds: SECS, slowMs: SLOW, achievedRate: Math.round(written / (elapsed / 1000)), commitsWritten: written, turns: itemsAtEnd, commitsSeenByTheLoop: coveredAtEnd, commitsPerTurn: r1(coveredAtEnd / Math.max(1, itemsAtEnd - 1)), waitingAtEnd, maxWaiting: maxSize, heapGrowthMB: r1(growth / 1e6), bytesPerWaitingCommit: mode === 'every' && waitingAtEnd > 0 ? Math.round(growth / waitingAtEnd) : null, samples: samples.filter((_, i) => i % 5 === 4) })
}

if (PART === 'cost') {
  const ROWS = 10000, ROUNDS = 7
  const mk = () => { const s = fero('s', { data: seedRows(ROWS) }); s.eng.promote(); return s }
  let v = 0
  const writeOn = (s, j) => s.set(['k' + ((j * 7919) % ROWS), 'n'], ++v)
  const ways = {}
  // each way: { m, run(m) } returning a promise; its resource and link are made once, here
  { const s = mk(); ways.none = { m: 100000, run: async (m) => { for (let j = 0; j < m; j++) writeOn(s, j) } } }
  { const s = mk(); let n = 0; s.data.connect(() => { n++ }); ways.callback = { m: 100000, run: async (m) => { for (let j = 0; j < m; j++) writeOn(s, j) } } }
  { const s = mk(); let n = 0; s.data.connect((st, c) => { const ds = c.changes; for (let i = 0; i < ds.length; i++) if (ds[i].prev !== undefined) n++ }); ways['callback reads changes and prev'] = { m: 100000, run: async (m) => { for (let j = 0; j < m; j++) writeOn(s, j) } } }
  const loopWay = (opts, B) => {
    const s = mk(); const h = s.data.connect(opts); const it = h[Symbol.asyncIterator]()
    let drained = null, n = 0
    ;(async () => { for await (const x of it) { n++; if (drained !== null && it.size === 0) { const r = drained; drained = null; r() } } })()
    return { m: B === 1 ? 20000 : 100000, run: async (m) => {
      for (let j = 0; j < m; j += B) {
        for (let k = 0; k < B; k++) writeOn(s, j + k)
        await new Promise((r) => { drained = r })
      }
    } }
  }
  ways['every-burst100'] = loopWay({ from: 'now' }, 100)
  ways['merge-burst100'] = loopWay(undefined, 100)
  ways['every-pingpong'] = loopWay({ from: 'now' }, 1)
  ways['merge-pingpong'] = loopWay(undefined, 1)
  { const s = mk(); ways['none-pingpong'] = { m: 20000, run: async (m) => { for (let j = 0; j < m; j++) { writeOn(s, j); await null } } } }
  for (const w of Object.values(ways)) await w.run(2000) // warm
  const xs = Object.fromEntries(Object.keys(ways).map((k) => [k, []]))
  const names = Object.keys(ways)
  for (let r = 0; r < ROUNDS; r++) {
    const order = names.slice(r % names.length).concat(names.slice(0, r % names.length)) // rotate the order each round
    for (const k of order) { gc(); const w = ways[k]; const t0 = now(); await w.run(w.m); xs[k].push(Number(now() - t0) / w.m) }
  }
  const nsPerCommit = Object.fromEntries(names.map((k) => [k, r1(med(xs[k]))]))
  const over = (a, b) => r1(med(xs[a].map((x, i) => x - xs[b][i]))) // inside each round, then the median
  out({ part: 'cost', rows: ROWS, rounds: ROUNDS, nsPerCommit, overNone: { callback: over('callback', 'none'), 'callback reads changes and prev': over('callback reads changes and prev', 'none'), 'every-burst100': over('every-burst100', 'none'), 'merge-burst100': over('merge-burst100', 'none') }, pingpongOverItsOwnWait: { every: over('every-pingpong', 'none-pingpong'), merge: over('merge-pingpong', 'none-pingpong') }, forAwaitOverCallback: { 'every-burst100': over('every-burst100', 'callback'), 'merge-burst100': over('merge-burst100', 'callback') } })
}
