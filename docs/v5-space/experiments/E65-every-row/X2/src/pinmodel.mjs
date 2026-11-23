// E-65 X2: what a pin costs a copy, by arithmetic (no run). A pin keeps, for each row that changes after it and
// that the scan has not passed yet, the row as it was at the pin (an "image"). With uniform writes at w a second
// over a group of n rows, and a scan that walks the group at an even pace over T seconds, the images held at
// time t are about  n * (1 - t/T) * (1 - exp(-w t / n))  when images are dropped once passed (server.mjs does),
// and  n * (1 - exp(-w t / n))  when every copy keeps them all (the replicated pin of the sim's 'cut' mode, which
// does not know the cursor). Both are capped by n: a pin never holds more than one image a row.
//
//   node src/pinmodel.mjs [--n=625000] [--w=5000] [--T=20] [--B=117]
import { args } from './lib.mjs'
const o = args(process.argv.slice(2), { n: 625000, w: 5000, T: 20, B: 117, groups: 16 })
function peak(n, w, T, passed) {
  let best = 0, at = 0
  for (let i = 1; i <= 1000; i++) {
    const t = (T * i) / 1000
    const v = n * (passed ? 1 - t / T : 1) * (1 - Math.exp((-w * t) / n))
    if (v > best) { best = v; at = t }
  }
  return { images: Math.round(best), at: +at.toFixed(1) }
}
const rows = []
for (const w of [o.w, 5000, 20000, 50000]) for (const T of [o.T, 10, 60, 600]) {
  const a = peak(o.n, w, T, true), b = peak(o.n, w, T, false)
  rows.push({ n: o.n, w, T, peakDropped: a.images, MBdropped: +((a.images * o.B) / 1048576).toFixed(1), peakAll: b.images, MBall: +((b.images * o.B) / 1048576).toFixed(1), groupsTimes: o.groups })
}
const seen = new Set()
for (const r of rows) { const k = `${r.w}|${r.T}`; if (seen.has(k)) continue; seen.add(k); console.log(JSON.stringify(r)) }
console.log(JSON.stringify({ cap: 'one image a row at most', capMB: +((o.n * o.B) / 1048576).toFixed(1), perGroupRows: o.n }))
