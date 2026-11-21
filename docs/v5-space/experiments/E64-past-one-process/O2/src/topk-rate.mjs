// E-64 O2, claim T2: how often a bounded top-k buffer runs short and needs a refill (a scan of its share's
// rows), by workload and buffer size. No data, no groups: one share of N rows, numbers only, ties by key.
//   node topk-rate.mjs <N> <workload> <k> <kp> [changes]
// Workloads, each a change to one row:
//   up       a score only grows (+0 to +10): a points leaderboard
//   walk     a score moves -10 to +10
//   uniform  a score is drawn again, uniform 0 to 1e6
//   churn    uniform, and 2 % of changes remove a random row and add a new one
//   topdel   uniform, and 1 % of changes remove the current best row (an adversary)
// It counts refills per 1e6 changes and checks the buffer's top k against a full sort every max(10,000, N/5) changes.
import { rng, out } from './lib.mjs'

const N = +process.argv[2], WL = process.argv[3], K = +process.argv[4], KP = +process.argv[5], CH = +(process.argv[6] ?? 1e6)
const KMAX = 2 * KP
const CHK = Math.max(10000, N / 5) // a full sort of N rows every CHK changes
const r = rng(N * 31 + K * 7 + KP)
const score = new Float64Array(N)
const live = new Uint8Array(N)
for (let i = 0; i < N; i++) { score[i] = Math.floor(r() * 1e6); live[i] = 1 }
let nextId = N
// a buffer: ids at or above tau (higher score first, then lower id), as a Map id -> score
const better = (sa, ia, sb, ib) => (sa !== sb ? sa > sb : ia < ib) // a ranks before b
let buf = new Map(), tauS = -Infinity, tauI = Infinity, hasTau = false, refills = 0, refillRows = 0, trims = 0
function refill() {
  refills++
  const top = [] // the best KP, kept sorted (small)
  for (let i = 0; i < N; i++) {
    if (!live[i]) continue
    refillRows++
    const s = score[i]
    if (top.length === KP && !better(s, i, top[KP - 1][0], top[KP - 1][1])) continue
    let j = top.length < KP ? top.length : KP - 1
    if (top.length < KP) top.push(null)
    while (j > 0 && better(s, i, top[j - 1][0], top[j - 1][1])) { top[j] = top[j - 1]; j-- }
    top[j] = [s, i]
  }
  buf = new Map(top.map(([s, i]) => [i, s]))
  hasTau = top.length >= KP
  if (hasTau) { tauS = top[KP - 1][0]; tauI = top[KP - 1][1] }
}
function change(i, s) { // s undefined: a remove
  buf.delete(i)
  if (s !== undefined && (!hasTau || !better(tauS, tauI, s, i))) buf.set(i, s)
  if (buf.size > KMAX) {
    const ts = [...buf].sort((a, b) => (better(a[1], a[0], b[1], b[0]) ? -1 : 1)).slice(0, KP)
    buf = new Map(ts); tauS = ts[KP - 1][1]; tauI = ts[KP - 1][0]; trims++
  }
  if (buf.size < K && hasTau) refill()
}
refill(); refills = 0; refillRows = 0
let bad = 0, checks = 0
const t0 = performance.now()
for (let c = 0; c < CH; c++) {
  let i = Math.floor(r() * N)
  if (WL === 'churn' && r() < 0.02) {
    if (live[i]) { live[i] = 0; change(i, undefined) }
    i = Math.floor(r() * N); if (!live[i]) { live[i] = 1; score[i] = Math.floor(r() * 1e6); change(i, score[i]) }
    continue
  }
  if (WL === 'topdel' && r() < 0.01) {
    let best = -1; for (const [j, s] of buf) if (best < 0 || better(s, j, score[best], best)) best = j
    if (best >= 0) { live[best] = 0; change(best, undefined) }
    continue
  }
  if (!live[i]) continue
  if (WL === 'up') score[i] += Math.floor(r() * 11)
  else if (WL === 'walk') score[i] += Math.floor(r() * 21) - 10
  else score[i] = Math.floor(r() * 1e6)
  change(i, score[i])
  if (c % CHK === CHK - 1) {
    checks++
    const ids = []; for (let j = 0; j < N; j++) if (live[j]) ids.push(j)
    ids.sort((a, b) => (better(score[a], a, score[b], b) ? -1 : 1))
    const want = ids.slice(0, K).join(',')
    const have = [...buf].sort((a, b) => (better(a[1], a[0], b[1], b[0]) ? -1 : 1)).slice(0, K).map((x) => x[0]).join(',')
    if (want !== have) bad++
  }
}
const secs = (performance.now() - t0) / 1000
out({ exp: 'E-64', opt: 'O2', claim: 'T2', rows: N, workload: WL, k: K, kp: KP, kmax: KMAX, changes: CH, refills, refillsPerMillion: +(refills * 1e6 / CH).toFixed(1), rowsScannedPerChange: +(refillRows / CH).toFixed(3), trims, checks, bad, secs: +secs.toFixed(1) })
void nextId
