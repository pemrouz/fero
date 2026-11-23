// E-65 probe (after the skeptic, finding 5): X1's sorted column (SortedCol, the exact live median) past 1e6
// values. Load n values (score-like whole numbers, 0 to 1e6), then churn: each change removes a value that is
// there and inserts a new one (a row's score changed). Times a change and one median read, and counts the bytes
// the chunks take a value after the churn (removes never merge chunks, so they can thin out).
//   node --max-old-space-size=3000 sortedcol-scale.mjs --n=10000000 [--changes=1000000] [--reads=2000]
// One JSON line.
import { SortedCol } from '../X1/src/compact.mjs'
import { args, out, rng, now, nsSince, loadavg } from '../X1/src/lib.mjs'
const A = args(), n = A.n ?? 1e6, H = A.changes ?? 1e6, R = A.reads ?? 2000
const r = rng(7), val = () => Math.floor(r() * 1e6)
const vals = new Float64Array(n), col = new SortedCol()
let t = now()
for (let i = 0; i < n; i++) { const x = val(); vals[i] = x; col.insert(x) }
const loadNs = nsSince(t) / n
t = now()
for (let h = 0; h < H; h++) { const i = Math.floor(r() * n), x = val(); if (!col.remove(vals[i])) throw new Error('lost value ' + vals[i]); col.insert(x); vals[i] = x }
const changeNs = nsSince(t) / H
let m = 0
t = now()
for (let j = 0; j < R; j++) m += col.median()
const readNs = nsSince(t) / R
// check the median against a sort of the true values once
const s = Float64Array.from(vals).sort(), h = (n - 1) * 0.5, lo = Math.floor(h), want = h === lo ? s[lo] : s[lo] + (h - lo) * (s[lo + 1] - s[lo])
const bytes = col.chunks.length * 2 * col.B * 8
out({ probe: 'sortedcol-scale', n, changes: H, chunks: col.chunks.length, bytes_per_value: +(bytes / n).toFixed(2), load_ns: Math.round(loadNs), change_ns: Math.round(changeNs), median_read_ns: Math.round(readNs), median_ok: col.median() === want, node: process.version, loadavg: loadavg() })
