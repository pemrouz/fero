// What a page reader's shared index costs its copy per write, beside a served leaderboard, at N rows (added after
// the skeptic's review, finding F1). XA-7's `{ pages }` keeps ONE ordered index of every row (data's `az` with the
// C1 comparator and no window: Copy.pageRead). Like a leaderboard, it is kept up on every write while it lives.
// Ways, each on a fresh copy of N rows (as copycost.mjs): no view; `best(10)` (data's az, window 10); the shared page
// index (built by one page read, then lingering); both. W writes of `points` (a value domain of 10), one commit each.
// The cost of a way = its time minus the same writes with no view. The ways interleave round by round, a full
// collection before each, the median of 5 rounds. Also N = 5,000, the row count of the guard's question (F23).
//   node --expose-gc --experimental-strip-types pagecost.mjs <N>
import { newCopy, sub, gcAsync, now, med, r3, out, rng } from './common.mjs'

const N = +process.argv[2], W = N >= 100000 ? 1000 : 2000, ROUNDS = 5
const ways = ['none', 'best', 'pages', 'both']
const xs = Object.fromEntries(ways.map((k) => [k, []]))
let indexes = 0
for (let round = 0; round < ROUNDS; round++) {
  for (const way of ways) {
    const { w, c } = newCopy(N)
    if (way === 'best' || way === 'both') sub(c, { method: 'best', arg: 10 })
    if (way === 'pages' || way === 'both') c.onMsg(1, 0, { t: 'get', h: 1e6, cls: 'C', method: 'page', arg: [5, 'k0'], place: 'x', seen: 0 })
    if (round === 0 && way === 'pages') indexes = w.stats.pageIndexes
    const r = rng(1000 + round)
    const ops = Array.from({ length: W }, () => [{ k: 'k' + (r() % N), f: 'points', v: r() % 10 }])
    await gcAsync()
    const t0 = now()
    for (let i = 0; i < W; i++) c.fold(i + 1, ops[i])
    xs[way].push(Number(now() - t0) / W / 1000)
  }
}
const usPerWrite = Object.fromEntries(ways.map((k) => [k, r3(med(xs[k]))]))
const viewUs = Object.fromEntries(ways.filter((k) => k !== 'none').map((k) => [k, r3(usPerWrite[k] - usPerWrite.none)]))
out({ claim: 'XA-7', bench: 'pagecost', rows: N, writes: W, pageIndexesBuilt: indexes, usPerWrite, viewUsPerChange: viewUs })
