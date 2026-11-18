// Claim 16, follow-up: what one class B view costs data per change, apart from the wire. A partition of P rows
// { stars, text }; the view gt('stars', t).za('stars', 10) (the shape claim 16 pushes down); W field writes to
// 'stars' of random rows, one commit each. The source built three ways, as the two sides of claim 16 build it:
//   seeded+promote  data's seed object, then promote() (claim 16's server)
//   seeded          the same seed, no promote()
//   written         an empty source filled by one batch of writes (claim 16's client cache, from a picture)
// ns per write with the view, and with no view (the fold alone). Data only: no lens, no wire.
//   node --expose-gc --experimental-strip-types viewprobe.mjs <P>
import { SourceNode, D } from '../proto/lens.mjs'
import { gc, now, out, r1, med, rng } from './common.mjs'

const P = +process.argv[2], W = 2000
const seed = () => { const r = rng(P * 7 + 1); const o = {}; for (let i = 0; i < P; i++) o['m' + i] = { stars: r() % 1000000, text: 'hello world ' + i }; return o }
const build = (how) => {
  const rt = new D.Runtime()
  if (how === 'written') { const s = new SourceNode(rt, {}); const o = seed(); rt.batch(() => { for (const k of Object.keys(o)) s.write(k, [], o[k]) }); return s }
  const s = new SourceNode(rt, seed())
  if (how === 'seeded+promote') s.promote()
  return s
}
const res = {}
for (const how of ['seeded+promote', 'seeded', 'written']) {
  for (const view of [false, true]) {
    const xs = []
    for (let rep = 0; rep < 5; rep++) {
      const s = build(how)
      let h = null
      if (view) { h = D.handleFor(s).gt('stars', 500000).za('stars', 10); h[D.value] }
      const r = rng(P + rep)
      const ks = Array.from({ length: W }, () => 'm' + (r() % P)), vs = Array.from({ length: W }, () => r() % 1000000)
      gc()
      const t0 = now()
      for (let i = 0; i < W; i++) s.write(ks[i], ['stars'], vs[i])
      xs.push(Number(now() - t0) / W)
    }
    res[how + (view ? ' +view' : '')] = r1(med(xs))
  }
}
const viewNs = Object.fromEntries(['seeded+promote', 'seeded', 'written'].map((h) => [h, r1(res[h + ' +view'] - res[h])]))
// the same view on claim 16's server source, with data's wireSink on it (what the server sends from); and the
// wireSink's records JSON-encoded, as claim 16's server does (runs 2 and 3 only)
for (const enc of [false, true]) {
  const xs = []
  let recs = 0
  for (let rep = 0; rep < 5; rep++) {
    const s = build('seeded+promote')
    const h = D.handleFor(s).gt('stars', 500000).za('stars', 10)
    D.wireSink(h, (b) => { if (b.seq === 0) return; recs += b.records.length; if (enc) JSON.stringify(b.records) })
    const r = rng(P + rep)
    const ks = Array.from({ length: W }, () => 'm' + (r() % P)), vs = Array.from({ length: W }, () => r() % 1000000)
    gc()
    const t0 = now()
    for (let i = 0; i < W; i++) s.write(ks[i], ['stars'], vs[i])
    xs.push(Number(now() - t0) / W)
  }
  res['seeded+promote +view +wireSink' + (enc ? ' +encode' : '')] = r1(med(xs))
  res['wire records per write' + (enc ? ' (encode run)' : '')] = Math.round((recs / (5 * W)) * 1000) / 1000
}
out({ claim: 16, bench: 'view-probe', rows: P, writes: W, ns: res, viewNsPerChange: viewNs, wireSinkNsPerChange: r1(res['seeded+promote +view +wireSink'] - res['seeded+promote +view']) })
