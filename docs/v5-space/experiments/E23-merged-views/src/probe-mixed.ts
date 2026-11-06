// E-23 side finding: is data's sorted view sound when a column's values are not
// all of one type? One source, one writer, no groups, no merge. 20,000 random
// upserts and removes over 2,000 keys; after each write, count rows the views
// show that are not live (phantoms), and how far the index outgrows the rows.
//
// usage: node --experimental-strip-types probe-mixed.ts
const DATA = process.env.DATA_DIR ?? '/home/user/pemrouz/data'
const D: any = await import(DATA + '/api/index.ts')
const { $, node: NODE, lane } = D
import { rng } from './lib.ts'

const cases: [string, (r: () => number) => unknown][] = [
  ['numbers only', (r) => Math.floor(r() * 101)],
  ['numbers + null/NaN/missing', (r) => { const u = r(); return u < 0.9 ? Math.floor(r() * 101) : u < 0.94 ? null : u < 0.97 ? NaN : undefined }],
  ['strings only', (r) => 's' + Math.floor(r() * 101)],
  ['numbers + 1% numeric strings', (r) => (r() < 0.99 ? Math.floor(r() * 101) : String(Math.floor(r() * 101)))],
  ['numbers + 1% "x"', (r) => (r() < 0.99 ? Math.floor(r() * 101) : 'x')],
  ['numbers + 0.1% "x"', (r) => (r() < 0.999 ? Math.floor(r() * 101) : 'x')],
]
for (const [name, gen] of cases) {
  const R = rng(3)
  const s = $({})
  const L = lane(s)
  const top = s.za('points', 10)
  const full = s.az('points')
  const live = new Set<string>()
  let phantomTop = 0, phantomFull = 0, grow = 0, firstBad = -1
  const t0 = performance.now()
  for (let i = 1; i <= 20000; i++) {
    const k = 'p' + Math.floor(R() * 2000)
    if (live.has(k) && R() < 0.3) { L([{ type: 2, key: [k] }]); live.delete(k) }
    else {
      const p = gen(R)
      L([{ type: 0, key: [k], value: p === undefined ? { id: k } : { id: k, points: p } }])
      live.add(k)
    }
    let pt = 0, pf = 0
    top[NODE].each((key: string) => { if (!live.has(key)) pt++ })
    full[NODE].each((key: string) => { if (!live.has(key)) pf++ })
    phantomTop += pt
    phantomFull += pf
    grow = Math.max(grow, full[NODE].index.keys.length - live.size)
    if ((pt || pf) && firstBad < 0) firstBad = i
  }
  console.log(`${name.padEnd(30)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(5)} s  first phantom at write ${String(firstBad).padStart(6)}  phantom rows shown: top-10 ${String(phantomTop).padStart(7)}, full ${String(phantomFull).padStart(9)}  index over live rows (max) ${grow}`)
}
