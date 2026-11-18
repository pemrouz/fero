// Claim 1, follow-up: is a step's cost with keys spread over 1e5-1e6 rows the prototype's way of building a
// step, or a Proxy per step as such? Four ways to build the same two-step read `L[k].n` then a read verb, on the
// same data store, keys spread (the case lens.mjs misses its bar on) and one key:
//   proto      lens.mjs as built: a fresh `function () {}` per step as the Proxy's target, four fields and a custom
//              inspector set on it (so util.inspect prints the path: Node inspects a Proxy's target, not its traps)
//   handler    the step's fields on a small class instance used as the Proxy HANDLER (its traps on the class's
//              prototype); the target a fresh arrow function with nothing set on it. Printing the path is lost
//   shared     as handler, with ONE shared arrow function as every step's target (a Proxy and a handler per step)
//   plain      no Proxy: a small class instance per step (what `f.at()` chains would cost if each key were a step)
// plus `direct` (the read with no lens) and `srcGet` (data's row lookup and a field read: the floor).
//   node --expose-gc --experimental-strip-types stepvariant.mjs <rows>
import { fero, VALUE } from '../proto/lens.mjs'
import { seedRows, key, out, interleave, r1 } from './common.mjs'

const N = +process.argv[2]
const f = fero('f', { data: seedRows(N) })
f.eng.promote()
const keys = Array.from({ length: N }, (_, i) => key(i))
const idx = (j) => keys[(j * 7919) % N]
const EMPTY = []
let sink = 0

function pathOf(t) {
  if (t.p !== null) return t.p
  if (t.up === null) return (t.p = EMPTY)
  const up = pathOf(t.up), p = new Array(up.length + 1)
  for (let i = 0; i < up.length; i++) p[i] = up[i]
  p[up.length] = t.k
  return (t.p = p)
}
// handler: the state is the handler; traps on its prototype
class StepH {
  constructor(r, up, k) { this.r = r; this.up = up; this.k = k; this.p = null }
  get(_t, k) {
    if (typeof k === 'symbol') return k === VALUE ? this.r.eng.readSync(pathOf(this)) : undefined
    return new Proxy(() => {}, new StepH(this.r, this, k))
  }
  apply() { return undefined }
}
const SHARED = () => {}
class StepS {
  constructor(r, up, k) { this.r = r; this.up = up; this.k = k; this.p = null }
  get(_t, k) {
    if (typeof k === 'symbol') return k === VALUE ? this.r.eng.readSync(pathOf(this)) : undefined
    return new Proxy(SHARED, new StepS(this.r, this, k))
  }
  apply() { return undefined }
}
class StepP {
  constructor(r, up, k) { this.r = r; this.up = up; this.k = k; this.p = null }
  step(k) { return new StepP(this.r, this, k) }
  get [VALUE]() { return this.r.eng.readSync(pathOf(this)) }
}
const LP = f.data
const LH = new Proxy(() => {}, new StepH(f, null, undefined))
const LS = new Proxy(SHARED, new StepS(f, null, undefined))
const LPl = new StepP(f, null, undefined)
const W = 200000
const k0 = keys[N >> 1]
const same = interleave({
  direct: (c) => { for (let j = 0; j < c; j++) sink += f.eng.readSync([k0, 'n']) },
  proto: (c) => { for (let j = 0; j < c; j++) sink += LP[k0].n[VALUE] },
  handler: (c) => { for (let j = 0; j < c; j++) sink += LH[k0].n[VALUE] },
  shared: (c) => { for (let j = 0; j < c; j++) sink += LS[k0].n[VALUE] },
  plain: (c) => { for (let j = 0; j < c; j++) sink += LPl.step(k0).step('n')[VALUE] },
}, W, 7)
const spread = interleave({
  direct: (c) => { for (let j = 0; j < c; j++) sink += f.eng.readSync([idx(j), 'n']) },
  proto: (c) => { for (let j = 0; j < c; j++) sink += LP[idx(j)].n[VALUE] },
  handler: (c) => { for (let j = 0; j < c; j++) sink += LH[idx(j)].n[VALUE] },
  shared: (c) => { for (let j = 0; j < c; j++) sink += LS[idx(j)].n[VALUE] },
  plain: (c) => { for (let j = 0; j < c; j++) sink += LPl.step(idx(j)).step('n')[VALUE] },
  srcGet: (c) => { const m = f.eng.src; for (let j = 0; j < c; j++) sink += m.get(idx(j)).n },
}, W, 7)
// the share per step: (two steps and the verb − the direct read) / 2
const per = (o) => Object.fromEntries(['proto', 'handler', 'shared', 'plain'].map((k) => [k, r1((o[k] - o.direct) / 2)]))
out({ claim: 1, bench: 'step-variant', rows: N, ops: W, same, spread, stepSame: per(same), stepSpread: per(spread), sink: sink > 0 })
