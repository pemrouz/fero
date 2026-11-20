// A1's cost: what one served view costs its copy per change, at N rows. A copy of N rows (seeded and promoted, as
// E-55 claim 16's server); one entry with one subscriber; W writes of the field the view reads, one commit each
// (best and after: points, a value domain of 10; byTeam and total: pts). The cost of a view is the time with it minus
// the same writes with no entry. Each time includes data's fold, the view, and the frame's one encode (the copy's
// own code). The ways interleave round by round, a full collection before each, the median of 5 rounds.
//   node --expose-gc --experimental-strip-types copycost.mjs <N>
import { newCopy, sub, gcAsync, now, med, r1, r3, out, rng } from './common.mjs'

const N = +process.argv[2], W = N >= 100000 ? 1000 : 2000, ROUNDS = 5
const views = {
  best: { spec: { method: 'best', arg: 10 }, f: 'points' },
  after: { spec: { method: 'after', arg: [5, 'k' + (N >> 1)] }, f: 'points' },
  byTeam: { spec: { method: 'byTeam', arg: null }, f: 'pts' },
  total: { spec: { method: 'total', arg: null }, f: 'pts' },
}
const ways = ['none:points', 'none:pts', ...Object.keys(views)]
const xs = Object.fromEntries(ways.map((k) => [k, []]))
const info = {}
for (let round = 0; round < ROUNDS; round++) {
  for (const way of ways) {
    const { w, c } = newCopy(N)
    let f = way.startsWith('none:') ? way.slice(5) : views[way].f
    if (!way.startsWith('none:')) sub(c, views[way].spec)
    const pic = w.sent.bytes
    const r = rng(1000 + round)
    const ops = Array.from({ length: W }, () => { const k = 'k' + (r() % N); return [{ k, f, v: f === 'points' ? r() % 10 : ((r() % 2001) - 1000) / 10 }] })
    w.sent.n = 0; w.sent.bytes = 0; w.stats.encodes = 0
    await gcAsync()
    const t0 = now()
    for (let i = 0; i < W; i++) c.fold(i + 1, ops[i])
    xs[way].push(Number(now() - t0) / W / 1000)
    if (round === 0 && !way.startsWith('none:')) info[way] = { pictureBytes: pic, framesPerWrite: r3(w.stats.encodes / W), bytesPerFrame: w.stats.encodes ? r1(w.sent.bytes / w.stats.encodes) : 0, encodesPerFrame: w.sent.n ? r3(w.stats.encodes / w.sent.n) : null }
  }
}
const usPerWrite = Object.fromEntries(ways.map((k) => [k, r3(med(xs[k]))]))
const viewUs = Object.fromEntries(Object.keys(views).map((k) => [k, r3(usPerWrite[k] - usPerWrite['none:' + views[k].f])]))
out({ claim: 'A1', bench: 'copycost', rows: N, writes: W, usPerWrite, viewUsPerChange: viewUs, info })
