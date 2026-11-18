// Claim 6, follow-up: what a target's registration costs (a WeakRef and a FinalizationRegistry entry), made B at a
// time in one job (B = 1, 10, 100, 1,000, 10,000), a new job (setImmediate) between batches. A WeakRef keeps its
// target alive to the end of the job that made it (the spec's KeepDuringJob set), so many made in one job may cost
// more than one at a time. 10,000 registrations a way, median of 5 rounds; the clock runs only inside the batches.
//   node --expose-gc --experimental-strip-types weakprobe.mjs
import { gc, now, out, r1, med, seedRows } from './common.mjs'
import { fero } from '../proto/lens.mjs'

// E55_ROWS (env, default 0): first load a server resource of that many rows, as connect.mjs setup does, and make
// and close 50,000 links on it, so the probe runs in a process like the setup bench's
const ROWS = +(process.env.E55_ROWS ?? 0)
let keep = null
if (ROWS > 0) {
  const f = fero('f', { data: seedRows(ROWS) }); f.eng.promote()
  for (let r = 0; r < 5; r++) { const ls = []; for (let i = 0; i < 10000; i++) ls.push(f.data.k5.connect({ v: 0 }, (t) => { t.v++ })); for (const l of ls) l.close() }
  keep = f
}

const M = 10000
const reg = new FinalizationRegistry(() => {})
const tick = () => new Promise((r) => setImmediate(r))
const res = {}
for (const B of [1, 10, 100, 1000, 10000]) {
  for (const [name, fn] of [
    ['weakref', (t, w, i) => { w[i] = new WeakRef(t[i]) }],
    ['register', (t, w, i) => { reg.register(t[i], i) }],
    ['both', (t, w, i) => { w[i] = new WeakRef(t[i]); reg.register(t[i], i) }],
    ['object', (t, w, i) => { w[i] = { t: t[i] } }], // a plain object holding the target: the floor
    ['empty', () => {}], // the loop and the clock alone, to subtract
  ]) {
    const xs = []
    for (let r = 0; r < 5; r++) {
      const ts = Array.from({ length: M }, () => ({})), ws = new Array(M)
      gc(); await tick()
      let ns = 0
      for (let s = 0; s < M; s += B) {
        const t0 = now()
        for (let i = s; i < s + B; i++) fn(ts, ws, i)
        ns += Number(now() - t0)
        await tick()
      }
      xs.push(ns / M)
    }
    res[`${name} B=${B}`] = r1(med(xs))
  }
}
const net = {}
for (const k of Object.keys(res)) if (!k.startsWith('empty')) net[k] = r1(res[k] - res['empty B=' + k.split('B=')[1]])
out({ claim: 6, bench: 'weak-probe', loadedRows: ROWS, registrations: M, ns: res, nsNet: net, held: keep !== null })
