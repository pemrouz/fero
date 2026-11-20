// A5's and XA-7's costs at N rows:
//   memory per served view: 10 entries best(1) .. best(10) (each its own data index of every row); heap after minus
//     heap before, over 10
//   the size check per commit: views.rows is one rowCount() per entry per commit (ns per call)
//   pages (XA-7): 1,000 page reads with distinct cursors against one shared index (heap per read, and the index
//     itself), against the plan as written: one served entry per cursor (heap per entry; 16 of them)
//   node --expose-gc --experimental-strip-types viewmem.mjs <N>
import { newCopy, gcAsync, now, med, r1, r3, out, heap, rng } from './common.mjs'

const N = +process.argv[2]
const res = {}
{ // memory per served view
  const xs = []
  for (let rep = 0; rep < 3; rep++) {
    const { c } = newCopy(N)
    await gcAsync(); const h0 = heap()
    for (let n = 1; n <= 10; n++) c.onMsg(1, 0, { t: 'sub', h: n, cls: 'C', method: 'best', arg: n, place: 'x', seen: 0 })
    await gcAsync(); xs.push((heap() - h0) / 10)
  }
  res.bytesPerBestView = Math.round(med(xs))
}
{ // the size check
  const { c } = newCopy(N)
  for (let n = 1; n <= 10; n++) c.onMsg(1, 0, { t: 'sub', h: n, cls: 'C', method: 'best', arg: n, place: 'x', seen: 0 })
  const es = [...c.entries.values()]
  const xs = []
  for (let round = 0; round < 5; round++) { let s = 0; const t0 = now(); for (let i = 0; i < 100000; i++) for (const e of es) s += e.view.size(); xs.push(Number(now() - t0) / (100000 * es.length)); if (s < 0) console.log(s) }
  res.sizeCheckNsPerEntry = r1(med(xs))
}
{ // pages: one shared index
  const { c } = newCopy(N)
  const r = rng(3)
  c.onMsg(1, 0, { t: 'get', h: 1, cls: 'C', method: 'page', arg: [5, 'k0'], place: 'x', seen: 0 })
  await gcAsync(); const h0 = heap()
  for (let i = 0; i < 1000; i++) c.onMsg(1, 0, { t: 'get', h: 2 + i, cls: 'C', method: 'page', arg: [r() % 10, 'k' + (r() % N)], place: 'x', seen: 0 })
  await gcAsync()
  const heapPerRead = Math.round((heap() - h0) / 1000) // what 1,000 reads left behind, after a collection
  const t0 = now()
  for (let i = 0; i < 1000; i++) c.onMsg(1, 0, { t: 'get', h: 2000 + i, cls: 'C', method: 'page', arg: [r() % 10, 'k' + (r() % N)], place: 'x', seen: 0 })
  res.pages = { indexes: c.w.stats.pageIndexes, entries: c.entries.size, heapPerRead, usPerRead: r1(Number(now() - t0) / 1000 / 1000) }
}
{ // the plan as written: one served entry per cursor (each its own index)
  const { c } = newCopy(N)
  const r = rng(3)
  await gcAsync(); const h0 = heap()
  for (let i = 0; i < 16; i++) c.onMsg(1, 0, { t: 'get', h: 1 + i, cls: 'C', method: 'after', arg: [r() % 10, 'k' + (r() % N)], place: 'x', seen: 0 })
  await gcAsync()
  res.entryPerCursor = { entries: c.entries.size, heapPerEntry: Math.round((heap() - h0) / 16) }
}
out({ claim: 'A5/XA-7', bench: 'viewmem', rows: N, ...res })
