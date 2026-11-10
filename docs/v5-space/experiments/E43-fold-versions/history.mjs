// E-43 side probe: is a view's value a function of the rows, or of the records that led to them?
// Two tiny scripted histories that end in the same rows as a third, shorter one.
//   node history.mjs <tree>
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
const TREE = process.argv[2]
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const run = (recs) => { const p = D.$({}); const sum = p.sum('n'), avg = p.avg('n'); sum.connect({}, () => {}); avg.connect({}, () => {}); const lane = D.lane(p, {}); for (const r of recs) lane([r]); const q = D.$(structuredClone(p[D.value])); return { rows: JSON.stringify(p[D.value]), liveSum: String(sum[D.value]), rebuiltSum: String(q.sum('n')[D.value]), liveAvg: String(avg[D.value]), rebuiltAvg: String(q.avg('n')[D.value]) } }   // rebuilt: the same views over a new source made from the final rows (a view declared alike on the same source is the same view)
const ins = (k, n) => ({ type: 1, key: [], at: k, value: { n } }), del = (k) => ({ type: 2, key: [k] })
const out = {
  'only a': run([ins('a', 0.1)]),
  'a, then a huge b, then b removed': run([ins('a', 0.1), ins('b', 1e21), del('b')]),
  'a, then a NaN c, then c removed': run([ins('a', 0.1), ins('c', NaN), del('c')]),
  'ten rows of 0.1 added and nine removed': run([...Array(10).keys()].map((i) => ins('r' + i, 0.1)).concat([...Array(9).keys()].map((i) => del('r' + (i + 1))))),
}
console.log(JSON.stringify({ data: fs.readFileSync(TREE + '/COMMIT', 'utf8').trim(), node: process.version, cases: out }))
