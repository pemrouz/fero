// E-65 X5, part `sample` timing: what a slot sample costs the copy and the asker.
//   filter   the copy drops records of slots the asker does not hold: one bitmap test a record (records carry
//            their slot, E-19), over 1e7 records
//   fold     the asker's live per-slot aggregates (count, sum, paid) and one sorted column per held slot,
//            per sampled write (an update: old value out, new value in)
//   read     one whole read: count, sum, mean, paid share with intervals from the per-slot aggregates, and a
//            median with Woodruff's interval from the per-slot sorted columns
// Sample sizes: 62,500 and 625,000 held rows (a resource of 1e6 and 1e7 rows at 256 of 4,096 slots).
// Usage: node sample-bench.mjs [run]   prints one JSON line
const S = 4096, K = 256, Z = 1.96
let seed = 7
const r = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }

function benchFilter() {
  const n = 1e7, slots = new Uint16Array(n)
  for (let i = 0; i < n; i++) slots[i] = Math.floor(r() * S)
  const held = new Uint8Array(S); for (let s = 0; s < S; s += 16) held[s] = 1
  let kept = 0
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) if (held[slots[i]]) kept++
  const ns = Number(process.hrtime.bigint() - t0) / n
  return { nsPerRecord: +ns.toFixed(2), kept }
}

// sorted Float64Array per slot, with insert and remove by binary search (a column per slot, as X1's median)
function lowerBound(a, n, v) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m } return lo }
function upperBound(a, n, v) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m } return lo }

function build(rowsHeld) {
  const per = Math.ceil(rowsHeld / K) * 2
  const col = [], n = new Int32Array(K), sum = new Float64Array(K), paid = new Float64Array(K)
  const rows = []
  for (let i = 0; i < K; i++) col.push(new Float64Array(per))
  for (let j = 0; j < rowsHeld; j++) {
    const i = Math.floor(r() * K), v = Math.exp(3 + 0.6 * (r() + r() + r() - 1.5)), p = r() < 0.5 ? 1 : 0
    const a = col[i], at = lowerBound(a, n[i], v); a.copyWithin(at + 1, at, n[i]); a[at] = v; n[i]++
    sum[i] += v; paid[i] += p; rows.push([i, v, p])
  }
  return { col, n, sum, paid, rows }
}
function update(st, j, v2) {                                  // one sampled write: a row's value changes
  const row = st.rows[j], i = row[0], a = st.col[i]
  let at = lowerBound(a, st.n[i], row[1]); a.copyWithin(at, at + 1, st.n[i]); st.n[i]--
  at = lowerBound(a, st.n[i], v2); a.copyWithin(at + 1, at, st.n[i]); a[at] = v2; st.n[i]++
  st.sum[i] += v2 - row[1]; row[1] = v2
}
function read(st) {
  const fpc = 1 - K / S
  let N = 0, SUM = 0, P = 0
  for (let i = 0; i < K; i++) { N += st.n[i]; SUM += st.sum[i]; P += st.paid[i] }
  const xbar = N / K, R = SUM / N
  let vx = 0, vd = 0
  for (let i = 0; i < K; i++) { vx += (st.n[i] - xbar) ** 2; vd += (st.sum[i] - R * st.n[i]) ** 2 }
  const count = [N * S / K, Z * S * Math.sqrt(fpc * vx / (K - 1) / K)]
  const mean = [R, Z * Math.sqrt(fpc * vd / (K - 1) / K) / xbar]
  // median: find the value with half the held rows below it by bisection over the value range, counting
  // per slot with a binary search; then Woodruff's interval from the per-slot counts below it
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < K; i++) if (st.n[i]) { lo = Math.min(lo, st.col[i][0]); hi = Math.max(hi, st.col[i][st.n[i] - 1]) }
  const below = (v) => { let c = 0; for (let i = 0; i < K; i++) c += upperBound(st.col[i], st.n[i], v); return c }
  const rankAt = (q) => { let a = lo, b = hi; for (let it = 0; it < 50; it++) { const m = (a + b) / 2; if (below(m) < q * N) a = m; else b = m } return b }
  const Q = rankAt(0.5)
  let vq = 0
  for (let i = 0; i < K; i++) { const c = upperBound(st.col[i], st.n[i], Q); vq += (c - 0.5 * st.n[i]) ** 2 }
  const se = Math.sqrt(fpc * vq / (K - 1) / K) / xbar
  const median = [Q, rankAt(0.5 - Z * se), rankAt(0.5 + Z * se)]
  return { count, mean, P, median }
}

const out = { part: 'sample-bench', run: +(process.argv[2] ?? 1), node: process.version }
out.filter = benchFilter()
for (const held of [62500, 625000]) {
  const st = build(held)
  const U = 200000
  const t0 = process.hrtime.bigint()
  for (let u = 0; u < U; u++) update(st, Math.floor(r() * held), Math.exp(3 + 0.6 * (r() + r() + r() - 1.5)))
  const foldNs = Number(process.hrtime.bigint() - t0) / U
  const R = 200
  read(st)
  const t1 = process.hrtime.bigint()
  let sink = 0
  for (let i = 0; i < R; i++) sink += read(st).median[0]
  const readUs = Number(process.hrtime.bigint() - t1) / R / 1000
  out['held' + held] = { foldNsPerWrite: +foldNs.toFixed(0), readUs: +readUs.toFixed(1), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), sink: sink > 0 }
}
console.log(JSON.stringify(out))
