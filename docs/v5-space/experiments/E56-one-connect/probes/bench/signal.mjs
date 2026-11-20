// Probe 4b (I4): what `{ signal }` costs a link, timed. Two ways to listen, alone (no fero): a listener per link on the
// shared AbortSignal (what proto/connect.mjs does) against one listener per signal and a Set of its links (what
// CONNECT.md and READS.md say fero does). Then the prototype's whole connect() and disconnect() on one row of a server,
// with no end option, with { signal } (one shared signal) and with { until } (a socket-like thing). n links are made,
// then ended in the order they were made. Each way runs 7 rounds, interleaved; per way and n, the median ns a link.
//   node --expose-gc --experimental-strip-types signal.mjs
import { EventEmitter } from 'node:events'
import { fero } from '../../../E55-lens-prototype/proto/lens.mjs'
import '../proto/connect.mjs'

const ROUNDS = 7, NS = [10, 100, 1000, 10000]
const now = () => process.hrtime.bigint()
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const r1 = (x) => Math.round(x * 10) / 10

// one listener per link: add n, then remove each (the platform walks its list on add and on remove)
function perLink(n) {
  const ac = new AbortController(), s = ac.signal, fns = new Array(n)
  const t0 = now()
  for (let i = 0; i < n; i++) { const f = () => {}; fns[i] = f; s.addEventListener('abort', f, { once: true }) }
  const t1 = now()
  for (let i = 0; i < n; i++) s.removeEventListener('abort', fns[i])
  const t2 = now()
  return { add: Number(t1 - t0) / n, remove: Number(t2 - t1) / n }
}
// one listener per signal and a Set of its links: the first link adds the listener, the last one out removes it
const bySignal = new WeakMap()
function join(s, link) {
  let g = bySignal.get(s)
  if (g === undefined) { g = { links: new Set(), fn: null }; g.fn = () => { for (const l of g.links) l.end() }; s.addEventListener('abort', g.fn, { once: true }); bySignal.set(s, g) }
  g.links.add(link)
}
function leave(s, link) { const g = bySignal.get(s); g.links.delete(link); if (g.links.size === 0) { s.removeEventListener('abort', g.fn); bySignal.delete(s) } }
function perSignal(n) {
  const ac = new AbortController(), s = ac.signal, links = new Array(n)
  const t0 = now()
  for (let i = 0; i < n; i++) { const l = { end() {} }; links[i] = l; join(s, l) }
  const t1 = now()
  for (let i = 0; i < n; i++) leave(s, links[i])
  const t2 = now()
  return { add: Number(t1 - t0) / n, remove: Number(t2 - t1) / n }
}
// the prototype: n links on one row of a server, made then ended; ns a link for both together
const sockLike = () => { const em = new EventEmitter(); em.destroyed = false; em.setMaxListeners(0); return em }
function proto(n, way) {
  const r = fero('s', { data: { k1: { n: 1 } } })
  const ac = new AbortController(), em = sockLike(), hs = new Array(n)
  const opts = way === 'signal' ? { signal: ac.signal } : way === 'until' ? { until: em } : undefined
  const fn = () => {}
  const t0 = now()
  for (let i = 0; i < n; i++) hs[i] = r.data.k1.connect(fn, opts)
  for (let i = 0; i < n; i++) hs[i].disconnect()
  const t1 = now()
  return Number(t1 - t0) / n
}

const out = { exp: 'E-56', probe: 4, part: 'signal', node: process.version, rounds: ROUNDS, mechanism: {}, connect: {} }
for (const n of NS) {
  const a = { perLinkAdd: [], perLinkRemove: [], perSignalAdd: [], perSignalRemove: [] }
  const c = { none: [], signal: [], until: [] }
  for (let w = 0; w < 2; w++) { perLink(n); perSignal(n); proto(n, 'none'); proto(n, 'signal'); proto(n, 'until') } // warm
  for (let k = 0; k < ROUNDS; k++) {
    globalThis.gc?.()
    const x = perLink(n); a.perLinkAdd.push(x.add); a.perLinkRemove.push(x.remove)
    const y = perSignal(n); a.perSignalAdd.push(y.add); a.perSignalRemove.push(y.remove)
    globalThis.gc?.()
    for (const way of ['none', 'signal', 'until']) c[way].push(proto(n, way))
  }
  out.mechanism[n] = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, r1(med(v))]))
  out.connect[n] = { ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r1(med(v))])),
    signalOverNone: r1(med(c.signal.map((v, i) => v - c.none[i]))), untilOverNone: r1(med(c.until.map((v, i) => v - c.none[i]))) }
  await new Promise((res) => setImmediate(res)) // let the microtask first calls of ended links run out
}
console.log(JSON.stringify(out))
