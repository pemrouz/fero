// E-62 item 3: what the `ended` guard costs in a real read trap (V5-13 pick 5; CONNECT 9; API.md 3.10, "The ended
// rule"). E-55 claim 1's read harness (bench/step.mjs `read`): one field read through a partition's live view, keys
// spread over the rows and one key, at 10^3, 10^5 and 10^6 rows; the ways interleaved round by round, differences
// taken inside a round, the median of the rounds.
//   node --expose-gc --experimental-strip-types ended.mjs <rows>
// The live view is E-55's View (c.now and Held.rows: a Proxy whose `get` looks the row up where it is held). E-56
// checked the rule with a SECOND Proxy over that view per link; a real build would instead put one flag check in the
// trap the view already has. Ways (the read is `rows[k].n`):
//   e55      E-55's own View trap, as built (no guard)
//   copy     the same trap, built here (to show this file's copy costs what E-55's does)
//   flag     the copy with the guard in it: `if (h.dead) throw ended`, one trap closure over one handle (a best case:
//            with one closure the compiler can treat the handle as a constant)
//   flagf    the same, one trap closure per handle (1,000 handles, one made per link, as a build with many links)
//   flagt    the same check with one handler shared by every handle, the handle on the Proxy's target
//   e56      E-56 probe 4's guard: a second Proxy over the view that checks the link, then reads through the view
//   direct   f.eng.readSync([k, 'n']), the read every lens verb turns into (claim 1's direct)
// And a row link's value (depth 1, a row is a partition): `h.value.n` through a getter, with and without the check.
import { fero, FeroError } from '../../E55-lens-prototype/proto/lens.mjs'
import { seedRows, key, out, interleave } from './common.mjs'

const N = +process.argv[2]
const W = +(process.env.READS ?? 200000), ROUNDS = +(process.env.ROUNDS ?? 9)
const f = fero('f', { data: seedRows(N) })
f.eng.promote()
const e = f.eng
const held = f.data.here() // a counted hold on the whole resource: its rows are E-55's View
const sel = held.sel
const keys = Array.from({ length: N }, (_, i) => key(i))
const idx = (j) => keys[(j * 7919) % N]
const k0 = keys[N >> 1]
let sink = 0

// a handle stand-in: what a real build's link keeps (dead is set once, when the link ends)
class Handle { constructor() { this.dead = false; this.why = null } }
const ended = (h) => new FeroError('ended', `rows read after their link ended (${h.why})`)
// In a real process some link has always ended already, so `dead` is a field that changes. End a spare handle of
// each kind first, so the compiler cannot treat the field as a constant false (with it constant, the flag is folded
// away). Done before any way is made or timed.
{ const hx = new Handle(); hx.dead = true; hx.why = 'x'; hx.dead = false }

const e55 = held.rows
const copy = new Proxy(Object.create(null), { get: (_, k) => (typeof k === 'string' ? e.rowOf(sel.part, k) : undefined) })
const h1 = new Handle()
const flag = new Proxy(Object.create(null), { get: (_, k) => { if (h1.dead) throw ended(h1); return typeof k === 'string' ? e.rowOf(sel.part, k) : undefined } })
// one trap closure per handle, made by one function, as each link would make its own: 1,000 handles, one of them read
const mkFlag = (h) => new Proxy(Object.create(null), { get: (_, k) => { if (h.dead) throw ended(h); return typeof k === 'string' ? e.rowOf(sel.part, k) : undefined } })
const HF = Array.from({ length: 1000 }, () => new Handle()), FF = HF.map(mkFlag)
const flagf = FF[500], hf = HF[500]
// one handler for every handle; each handle's view is a Proxy over a small target that names the handle
const SHARED = { get: (t, k) => { if (t.h.dead) throw ended(t.h); return typeof k === 'string' ? e.rowOf(t.part, k) : undefined } }
const h2 = new Handle()
const flagt = new Proxy({ h: h2, part: sel.part }, SHARED)
// E-56 probe 4's guardOf, line for line (proto/connect.mjs), over E-55's view
const conn = { dead: false, why: null, r: { name: 'f' }, path: [] }
{ const cx = { dead: false, why: null, r: { name: 'f' }, path: [] }; cx.dead = true; cx.dead = false } // as for Handle
const e56 = (() => {
  const v = sel.view
  const live = () => { if (conn.dead) throw new FeroError('ended', 'read after the link ended') }
  return new Proxy(Object.create(null), {
    get: (_, k) => { live(); return v.rows[k] },
    has: (_, k) => { live(); return k in v.rows },
  })
})()

// a row link's value: a getter, with and without the check
class RowH0 { constructor(p) { this.p = p } get value() { return e.readSync(this.p) } }
class RowH1 { constructor(p) { this.p = p; this.dead = false; this.why = null } get value() { if (this.dead) throw ended(this); return e.readSync(this.p) } }
{ const rx = new RowH1([k0]); rx.dead = true; rx.why = 'x'; rx.dead = false } // as for Handle
const r0 = new RowH0([k0]), r1 = new RowH1([k0])
const SPREAD_H = Math.min(N, 100000) // handles for spread keys (one per key, made up front)
const hs0 = Array.from({ length: SPREAD_H }, (_, i) => new RowH0([keys[(i * 7919) % N]]))
const hs1 = Array.from({ length: SPREAD_H }, (_, i) => new RowH1([keys[(i * 7919) % N]]))

const same = interleave({
  direct: () => { for (let j = 0; j < W; j++) sink = (sink + e.readSync([k0, 'n'])) & 1023; return W },
  e55: () => { for (let j = 0; j < W; j++) sink = (sink + e55[k0].n) & 1023; return W },
  copy: () => { for (let j = 0; j < W; j++) sink = (sink + copy[k0].n) & 1023; return W },
  flag: () => { for (let j = 0; j < W; j++) sink = (sink + flag[k0].n) & 1023; return W },
  flagf: () => { for (let j = 0; j < W; j++) sink = (sink + flagf[k0].n) & 1023; return W },
  flagt: () => { for (let j = 0; j < W; j++) sink = (sink + flagt[k0].n) & 1023; return W },
  e56: () => { for (let j = 0; j < W; j++) sink = (sink + e56[k0].n) & 1023; return W },
  row0: () => { for (let j = 0; j < W; j++) sink = (sink + r0.value.n) & 1023; return W },
  row1: () => { for (let j = 0; j < W; j++) sink = (sink + r1.value.n) & 1023; return W },
}, { rounds: ROUNDS, ops: W })
const spread = interleave({
  direct: () => { for (let j = 0; j < W; j++) sink = (sink + e.readSync([idx(j), 'n'])) & 1023; return W },
  e55: () => { for (let j = 0; j < W; j++) sink = (sink + e55[idx(j)].n) & 1023; return W },
  copy: () => { for (let j = 0; j < W; j++) sink = (sink + copy[idx(j)].n) & 1023; return W },
  flag: () => { for (let j = 0; j < W; j++) sink = (sink + flag[idx(j)].n) & 1023; return W },
  flagf: () => { for (let j = 0; j < W; j++) sink = (sink + flagf[idx(j)].n) & 1023; return W },
  flagt: () => { for (let j = 0; j < W; j++) sink = (sink + flagt[idx(j)].n) & 1023; return W },
  e56: () => { for (let j = 0; j < W; j++) sink = (sink + e56[idx(j)].n) & 1023; return W },
  row0: () => { for (let j = 0; j < W; j++) sink = (sink + hs0[j % SPREAD_H].value.n) & 1023; return W },
  row1: () => { for (let j = 0; j < W; j++) sink = (sink + hs1[j % SPREAD_H].value.n) & 1023; return W },
}, { rounds: ROUNDS, ops: W })

// the guard works: after the end every guarded read throws `ended`, the unguarded ones still answer
h1.dead = true; h1.why = 'disconnect'; hf.dead = true; hf.why = 'disconnect'; h2.dead = true; h2.why = 'disconnect'; conn.dead = true; r1.dead = true; r1.why = 'disconnect'
const throws = (fn) => { try { fn(); return false } catch (x) { return x.code === 'ended' } }
const check = { flag: throws(() => flag[k0]), flagf: throws(() => flagf[k0]), other_flagf_still_reads: FF[499][k0] !== undefined, flagt: throws(() => flagt[k0]), e56: throws(() => e56[k0]), row1: throws(() => r1.value), copy_still_reads: copy[k0] !== undefined }
const pair = (r, a, b) => r.diff(a, b)
out({
  item: 3, bench: 'ended', rows: N, reads: W, rounds: ROUNDS,
  same: same.ns, spread: spread.ns,
  derived: {
    same: { copy_minus_e55: pair(same, 'copy', 'e55'), flag_minus_copy: pair(same, 'flag', 'copy'), flagf_minus_copy: pair(same, 'flagf', 'copy'), flagt_minus_copy: pair(same, 'flagt', 'copy'), e56_minus_e55: pair(same, 'e56', 'e55'), row1_minus_row0: pair(same, 'row1', 'row0') },
    spread: { copy_minus_e55: pair(spread, 'copy', 'e55'), flag_minus_copy: pair(spread, 'flag', 'copy'), flagf_minus_copy: pair(spread, 'flagf', 'copy'), flagt_minus_copy: pair(spread, 'flagt', 'copy'), e56_minus_e55: pair(spread, 'e56', 'e55'), row1_minus_row0: pair(spread, 'row1', 'row0') },
  },
  check, sink: sink >= 0,
})
