// A7's cost, re-checking E-55 claim 16 in process: one partition of N rows, S distinct shapes of one chain
// gt('points', t).za('points', 10) (C1 ties), W writes of `points` (a value domain of 10), one commit each.
//   push (class B): the copy runs the S views and encodes each one's frame; the client decodes them
//   local (class A): the copy encodes the partition's frame once; the client decodes it, folds it into its own data
//     source and runs the S views here
// The copy's and the client's µs per write are timed apart; per shape = (mode - the same writes with no shape) / S.
// Bytes per write on the wire. The ways interleave round by round, a full collection before each, the median of 5.
//   node --expose-gc --experimental-strip-types classb.mjs <N>
import { newCopy, sub, gcAsync, now, med, r1, r3, out, rng, D } from './common.mjs'
import { SourceNode, buildChain, adapt } from '../proto/served.mjs'

const N = +process.argv[2], W = 1000
const res = {}
for (const S of [1, 10]) {
  const shapes = Array.from({ length: S }, (_, i) => [['gt', 'points', i % 9], ['za', 'points', 10]])
  const xs = { none: [], push: [], local: [] }, cl = { none: [], push: [], local: [] }, bytes = {}
  for (let round = 0; round < 5; round++) for (const mode of ['none', 'push', 'local']) {
    const { w, c } = newCopy(N, { depth: 2 })
    const texts = []
    w.toClient = (copy, link, m) => { if (typeof m === 'string') texts.push(m) }
    let local = null
    if (mode === 'push') for (const ops of shapes) sub(c, { cls: 'B', part: 'p0', ops })
    if (mode === 'local' || mode === 'none') {
      sub(c, { cls: 'A', part: 'p0' })
      // the client: its own data source with the partition, and (local) the S views here
      const rt = new D.Runtime(), src = new SourceNode(rt, Object.fromEntries(c.parts.get('p0').snapshot()))
      const views = mode === 'local' ? shapes.map((ops) => adapt(buildChain(D.handleFor(src), ops))) : []
      for (const v of views) v.connect(() => {})
      local = { rt, src, views }
    }
    texts.length = 0
    const r = rng(77 + round)
    const ops = Array.from({ length: W }, () => [{ p: 'p0', k: 'k' + (r() % N), f: 'points', v: r() % 10 }])
    await gcAsync()
    const t0 = now()
    for (let i = 0; i < W; i++) c.fold(i + 1, ops[i])
    xs[mode].push(Number(now() - t0) / W / 1000)
    bytes[mode] = texts.reduce((a, t) => a + t.length, 0) / W
    await gcAsync()
    const t1 = now()
    for (const t of texts) {
      const f = JSON.parse(t)
      if (local) local.rt.batch(() => { for (const x of f.r) { if (x[0] === 'r') local.src.remove(x[1]); else local.src.write(x[1], [], x[2]) } })
    }
    cl[mode].push(Number(now() - t1) / W / 1000)
  }
  const m = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r3(med(v))]))
  const cu = m(xs), cc = m(cl)
  res['S' + S] = { copyUsPerWrite: cu, clientUsPerWrite: cc, copyUsPerShape: { push: r3((cu.push - cu.none) / S), local: r3((cu.local - cu.none) / S) }, clientUsPerShape: { push: r3(cc.push / S), local: r3((cc.local - cc.none) / S) }, bytesPerWrite: { push: r1(bytes.push), local: r1(bytes.local) } }
}
out({ claim: 'A7', bench: 'classb', rows: N, ...res })
