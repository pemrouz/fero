// E-63 side probe (added after review): what a time budget on user rules costs a write. DESIGN-V5 4.3 runs the
// user code that judges (rules.write, validation, schema) on the kernel thread under a `vm` timeout. One tiny rule
// (the region check of the mix's conditional write) is called five ways, and the cost is per write:
//   direct          a plain function call, no guard
//   vm_each         one vm call a write, no timeout
//   vm_each_budget  one vm call a write with { timeout: 10 } (a budget a write)
//   vm_turn         one vm call a turn of 50 writes (one 1 ms tick at 50,000 writes a second), no timeout
//   vm_turn_budget  the same with { timeout: 10 } (a budget a turn: what E-63's +budget forms run)
// Then a rule that never returns, under { timeout: 10 }: how long until the call is cut (cut_ms).
//   node budget.mjs [writes]
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'

const N = +(process.argv[2] || 100000), TURN = 50
const ws = Array.from({ length: TURN }, (_, i) => ({ k: 'k' + i, eq: 'r' + (i % 16) }))
const row = { region: 'r3', n: 1 }
const ctx = vm.createContext({ row, ws, ok: new Uint8Array(TURN), w: ws[0], out: false, i: 0 })
vm.runInContext('function rule(row, w) { return row.region === w.eq }', ctx)
const one = new vm.Script('out = rule(row, w)')
const turn = new vm.Script('for (i = 0; i < ws.length; i++) ok[i] = rule(row, ws[i]) ? 1 : 0')
const rule = (r, w) => r.region === w.eq
let sink = 0, nth = 0
const perWrite = (calls, writesPerCall, fn) => { for (let i = 0; i < 2000; i++) fn(); const a = performance.now(); for (let i = 0; i < calls; i++) fn(); return +(((performance.now() - a) * 1000) / (calls * writesPerCall)).toFixed(3) }
const us = {
  direct: perWrite(N, 1, () => { sink += rule(row, ws[nth++ % TURN]) ? 1 : 0 }),
  vm_each: perWrite(N, 1, () => { one.runInContext(ctx) }),
  vm_each_budget: perWrite(N, 1, () => { one.runInContext(ctx, { timeout: 10 }) }),
  vm_turn: perWrite(N / TURN, TURN, () => { turn.runInContext(ctx) }),
  vm_turn_budget: perWrite(N / TURN, TURN, () => { turn.runInContext(ctx, { timeout: 10 }) }),
}
const cut = []
const loop = new vm.Script('for (;;) {}')
for (let i = 0; i < 5; i++) { const a = performance.now(); try { loop.runInContext(ctx, { timeout: 10 }) } catch (e) { if (e.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e } cut.push(+(performance.now() - a).toFixed(2)) }
const cores = (x) => +((x * 50000) / 1e6).toFixed(3) // cores this costs at 50,000 writes a second
console.log(JSON.stringify({ exp: 'E-63', part: 'budget', node: process.version, writes: N, turn: TURN, us_per_write: us,
  cores_at_50k: Object.fromEntries(Object.entries(us).map(([k, v]) => [k, cores(v)])), cut_ms: cut, sink: sink > 0 }))
