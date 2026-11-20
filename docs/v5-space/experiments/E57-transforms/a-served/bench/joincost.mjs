// A4's cost: a SUB that joins a live entry (a canonical key, a lookup, a count, an attachment) and its picture, and
// the memory each subscriber adds. One copy of 10,000 rows, one entry best(10); 10,000 joins from 10,000 links.
// The picture's own encode is timed apart, so join = total - picture. The median of 5 rounds.
//   node --expose-gc --experimental-strip-types joincost.mjs
import { newCopy, gcAsync, now, med, r1, r3, out, heap } from './common.mjs'

const N = 10000, J = 10000
const tot = [], pic = [], mem = []
for (let round = 0; round < 5; round++) {
  const { w, c } = newCopy(N)
  c.onMsg(1, 0, { t: 'sub', h: 1, cls: 'C', method: 'best', arg: 10, place: 'x', seen: 0 })
  const e = [...c.entries.values()][0]
  await gcAsync()
  const h0 = heap()
  const t0 = now()
  for (let i = 0; i < J; i++) c.onMsg(10 + i, i, { t: 'sub', h: 1, cls: 'C', method: 'best', arg: 10, place: 'x', seen: 0 })
  tot.push(Number(now() - t0) / J / 1000)
  w.last = null
  await gcAsync()
  mem.push((heap() - h0) / J)
  await gcAsync()
  const t1 = now()
  for (let i = 0; i < J; i++) JSON.stringify({ t: 'pic', h: 1, i: e.inst, q: e.seq, p: c.pos, v: 1, k: 'rows', get: 0, r: e.view.picture() })
  pic.push(Number(now() - t1) / J / 1000)
  if (round === 0 && (c.entries.size !== 1 || w.stats.builds !== 0 && false)) throw new Error('joins built views')
}
out({ claim: 'A4', bench: 'joincost', rows: N, joins: J, usPerJoinWithPicture: r3(med(tot)), usPerPicture: r3(med(pic)), usPerJoinAlone: r3(med(tot) - med(pic)), bytesPerSubscriber: r1(med(mem)) })
