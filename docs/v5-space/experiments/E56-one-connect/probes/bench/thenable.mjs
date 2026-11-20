// Probe 1 (I9, I11): a thenable handle (V-a), against a handle with no `then` and get() = connect({ once }) (V-b).
//   node --experimental-strip-types thenable.mjs
// One client over E-55's loopback transport (JSON frames), so SUBs, UNSUBs, GETs and bytes are counted. Three variants:
//   V-a   the handle is thenable: `await handle` gives the first state; the link stays open
//   V-a1  the same, but awaiting the handle also ends the link ("await means once")
//   V-b   the handle has no `then`; `lens.get()` is connect({ once }) and returns a promise of the state
// For each, seven ways a handle reaches code that resolves values. After each: what the caller got back, how many links
// stay open, whether the caller can still end them, and how many callback calls the next write makes.
// Then: what reading once costs on a client: E-55's get() (one GET of the path) against get() = connect({ once })
// (a SUB, the partition's picture, an UNSUB), for a field in a 1,000-row partition.
import { fero, Loop } from '../../../E55-lens-prototype/proto/lens.mjs'
import { counts, e55Read } from '../proto/connect.mjs'

const out = (o) => console.log(JSON.stringify({ exp: 'E-56', probe: 1, node: process.version, ...o }))
// what libraries do: "if it has a then function, await it" (the is-promise package's test, from memory; React's `use`,
// test runners' resolves and many loaders make the same kind of check)
const isPromiseLike = (x) => !!x && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function'
const maybeAwait = async (x) => (isPromiseLike(x) ? await x : x)
const tick = () => new Promise((r) => setImmediate(r))

// a loopback that also counts bytes: a picture's text, a change frame's text, a GET's answer
class CountLoop extends Loop {
  constructor(server, o) { super(server, o); this.stats.bytes = 0; this.stats.pictureBytes = 0 }
  frame(sel, c) { if (!(sel.dropped || this.subs.get(sel)?.dead)) { const n = c.text().length; this.stats.bytes += n; if (c.first) this.stats.pictureBytes += n } return super.frame(sel, c) }
  get(path) { return super.get(path).then((v) => { this.stats.bytes += JSON.stringify(v ?? null).length; return v }) }
}

const N = 1000
let wv = 100
for (const variant of ['a', 'a1', 'b']) {
  const srv = fero('shop', { data: { w: { stock: 5 }, g: { stock: 9 } } })
  const tr = new CountLoop(srv, { json: true })
  const cl = fero('shop', { role: 'client', transport: tr, linger: 0 })
  cl.e56 = { variant }
  let calls = 0
  const fn = () => { calls++ } // shared by every link this variant opens: counts calls at the next write
  const live = () => cl.eng.sels.get('w')?.count ?? 0
  const kind = (x) => (x === undefined ? 'undefined' : typeof x?.disconnect === 'function' ? 'a handle' : 'the state ' + JSON.stringify(x))
  const res = {}
  const step = async (name, make) => {
    const before = live(), sub0 = tr.stats.subs
    let mine = 0
    const got = await make(() => { mine++ })
    await tick()
    const firstCalls = mine
    calls = 0; mine = 0
    srv.data.w.stock.set(++wv) // one commit
    const openAfter = live() - before
    // can the caller end what it opened? only through what it got back
    const handles = (Array.isArray(got) ? got : [got]).filter((x) => typeof x?.disconnect === 'function')
    for (const h of handles) h.disconnect()
    res[name] = { gotBack: Array.isArray(got) ? `an array of ${got.length}: ${kind(got[0])}` : kind(got), callbackCallsBeforeTheWrite: firstCalls, linksLeftOpen: openAfter, callbackCallsAtNextWrite: mine, handlesTheCallerHolds: handles.length, linksStillOpenAfterTheCallerEndsWhatItHolds: live() - before, subsSent: tr.stats.subs - sub0 }
  }
  const both = (f) => (s, c) => { fn(s, c); f(s, c) }
  async function open(f) { return cl.data.w.connect(both(f)) }
  await step(`an async helper returns the handle, ${N} times`, async (f) => { const all = []; for (let i = 0; i < N; i++) all.push(await open(f)); return all })
  await step('const h = await lens.connect(fn)', async (f) => { const h = await cl.data.w.connect(both(f)); return h })
  await step('Promise.all of 3 handles', (f) => Promise.all([cl.data.w.connect(both(f)), cl.data.w.connect(both(f)), cl.data.w.connect(both(f))]))
  await step('Promise.race([handle, a timeout])', (f) => Promise.race([cl.data.w.connect(both(f)), new Promise((r) => setTimeout(() => r('timeout'), 50))]))
  await step('a .then callback returns the handle', (f) => Promise.resolve().then(() => cl.data.w.connect(both(f))))
  await step('Promise.resolve(handle)', (f) => Promise.resolve(cl.data.w.connect(both(f))))
  await step('a library: maybeAwait(handle)', (f) => maybeAwait(cl.data.w.connect(both(f))))
  // the plain, kept handle: what each variant gives with no resolving in between
  const h = cl.data.w.connect(fn)
  let firstState
  if (variant === 'b') { await h.ready; firstState = h.state } else firstState = await h
  let hc = 0; const h2 = cl.data.w.connect(() => { hc++ }); if (variant === 'b') await h2.ready; else await h2
  hc = 0; srv.data.w.stock.set(++wv)
  const keptHandle = { firstState: JSON.stringify(firstState), afterAwaitItsCallbackCallsAtNextWrite: hc, handleStillLive: !h2.dead }
  h2.disconnect(); h.disconnect()
  // read once: V-a awaits the handle; V-b calls get()
  const s0 = { ...tr.stats }
  const once = variant === 'b' ? await cl.data.g.get() : await cl.data.g.connect()
  await tick()
  const readOnce = { form: variant === 'b' ? 'await lens.get()' : 'await lens.connect()', value: JSON.stringify(once), subs: tr.stats.subs - s0.subs, unsubs: tr.stats.unsubs - s0.unsubs, gets: tr.stats.gets - s0.gets, linksLeftOnG: cl.eng.sels.get('g')?.count ?? 0, cacheRowsLeft: cl.eng.src.rowCount() }
  const probe = cl.data.w.connect(fn); const says = isPromiseLike(probe); probe.disconnect()
  out({ variant: { a: 'V-a: thenable, the link stays', a1: 'V-a1: thenable, await ends the link', b: 'V-b: no then; get() = connect({ once })' }[variant], cases: res, keptHandle, readOnce, isPromiseLikeSaysPromise: says, linksOnWLeftAtEnd: live() })
}

// read once on a client: a field in a 1,000-row partition (depth 2), the partition not held here
{
  const rows = {}; for (let i = 0; i < 1000; i++) rows['m' + i] = { name: 'user-' + i, n: i, tags: ['a', 'b'] }
  const srv = fero('chat', { depth: 2, data: { room1: rows } })
  const res = {}
  for (const way of ['E-55 get(): one GET of the path', 'V-b get() = connect({ once })']) {
    const tr = new CountLoop(srv, { json: true })
    const cl = fero('chat', { depth: 2, role: 'client', transport: tr, linger: 0 })
    const path = ['room1', 'm5', 'n']
    const v = way.startsWith('E-55') ? await e55Read.call(cl, path) : await cl.data.room1.m5.n.get()
    await tick()
    res[way] = { value: v, gets: tr.stats.gets, subs: tr.stats.subs, unsubs: tr.stats.unsubs, bytesToTheClient: tr.stats.bytes, rowsFoldedIntoTheCache: tr.stats.pictureBytes > 0 ? 1000 : 0, cacheRowsLeft: cl.eng.parts.get('room1')?.rowCount() ?? 0 }
  }
  // the same read when the partition is already held on purpose here (a live link): both are served here
  {
    const tr = new CountLoop(srv, { json: true })
    const cl = fero('chat', { depth: 2, role: 'client', transport: tr, linger: 0 })
    const keep = cl.data.room1.connect(); await keep.ready
    const s0 = { ...tr.stats }
    const a = await e55Read.call(cl, ['room1', 'm5', 'n']); const b = await cl.data.room1.m5.n.get()
    res['both, the partition already held here'] = { values: [a, b], gets: tr.stats.gets - s0.gets, subs: tr.stats.subs - s0.subs, bytes: tr.stats.bytes - s0.bytes }
    keep.disconnect()
  }
  out({ part: 'read once on a client', cases: res })
}
out({ part: 'counts', ...counts })
