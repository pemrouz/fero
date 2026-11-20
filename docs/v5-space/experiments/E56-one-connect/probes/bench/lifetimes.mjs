// Probe 4 (I3, I4): disconnect() and a lifetime option on the same link. Each case says what should happen and
// checks it. Run as is (every case must pass), with a planted bug (E56_MUTATE=twice | nosignalcleanup | untilclosed:
// some case must fail), and with E56_FIRST=sync (the first call inside connect(), as E-55's Link.attach does).
// A "limit" is what the design cannot do, recorded as seen, not counted.
//   node --experimental-strip-types lifetimes.mjs
import net from 'node:net'
import { EventEmitter, getEventListeners, once } from 'node:events'
import { MessageChannel } from 'node:worker_threads'
import { fero, Loop } from '../../../E55-lens-prototype/proto/lens.mjs'
import { policy, counts, MUT, getOnce } from '../proto/connect.mjs'

if (process.env.E56_FIRST === 'sync') policy.first = 'sync'
const out = (o) => console.log(JSON.stringify({ exp: 'E-56', probe: 4, node: process.version, mutate: MUT, first: policy.first, ...o }))
const flush = () => new Promise((r) => setImmediate(r))
const cases = []
const check = (name, ok, saw) => cases.push({ name, ok: !!ok, saw })
// a limit: what the design cannot do, recorded as seen (not counted as a pass or a fail)
const limit = (name, saw) => cases.push({ name, limit: true, saw })
const mk = () => fero('s', { data: { k1: { n: 1 }, k2: { n: 2 } } })
// a socket-like thing: it says 'close' once, and can say whether it already has (destroyed), as a Node socket does
const sockLike = () => { const em = new EventEmitter(); em.destroyed = false; return em }
const closeIt = (em) => { em.destroyed = true; em.emit('close') }
const count = (r, k = 'k1') => r.eng.sels.get(k)?.count ?? 0

// 1. disconnect twice
{
  const r = mk(); let b = 0
  const A = r.data.k1.connect(() => {}), B = r.data.k1.connect(() => { b++ })
  await flush()
  A.disconnect(); A.disconnect()
  b = 0; r.data.k1.n.set(2)
  check('disconnect twice: the other link on the row still gets the next commit', b === 1 && count(r) === 1, { otherLinkCalls: b, linksCounted: count(r) })
}
// 2. a signal that aborts after disconnect
{
  const r = mk(); const ac = new AbortController(); let b = 0
  const A = r.data.k1.connect(() => {}, { signal: ac.signal }), B = r.data.k1.connect(() => { b++ })
  await flush()
  A.disconnect()
  const left = getEventListeners(ac.signal, 'abort').length
  ac.abort()
  b = 0; r.data.k1.n.set(3)
  check('a signal aborts after disconnect: its listener was removed, nothing else ends', left === 0 && b === 1 && count(r) === 1, { abortListenersLeftAfterDisconnect: left, otherLinkCalls: b, linksCounted: count(r) })
}
// 2b. a signal that aborts after disconnect, while another disconnect already ran twice: the two bugs together
{
  const r = mk(); const ac = new AbortController(); let b = 0
  const A = r.data.k1.connect(() => {}, { signal: ac.signal }), B = r.data.k1.connect(() => { b++ })
  await flush()
  A.disconnect(); ac.abort()
  b = 0; r.data.k1.n.set(4)
  check('disconnect, then its signal aborts: the other link still gets the next commit', b === 1 && count(r) === 1, { otherLinkCalls: b, linksCounted: count(r) })
}
// 3. until on a socket that already closed
{
  const r = mk()
  const sock = new net.Socket(); sock.destroy(); await once(sock, 'close') // closed, and its 'close' already emitted
  const h = r.data.k1.connect(() => {}, { until: sock })
  await flush()
  check('until: a Node socket already destroyed: the link is born ended, no selection', h.dead && count(r) === 0, { linkEnded: h.dead, why: h.why, linksCounted: count(r) })
  // a thing that cannot say whether it closed: a plain EventEmitter that already said 'close', a MessagePort already
  // closed. With policy.until = 'strict' (the default) connect refuses them; 'loose' takes them, and the link never ends
  for (const pol of ['strict', 'loose']) {
    policy.until = pol
    const em = new EventEmitter(); em.emit('close')
    let h2 = null, err2 = null
    try { h2 = r.data.k1.connect(() => {}, { until: em }) } catch (e) { err2 = e.code }
    await flush()
    const { port1 } = new MessageChannel(); port1.close(); await flush()
    let h3 = null, err3 = null
    try { h3 = r.data.k1.connect(() => {}, { until: port1 }) } catch (e) { err3 = e.code }
    await flush()
    const saw = { plainEmitter: { refused: err2, linkEnded: h2?.dead ?? null }, closedMessagePort: { refused: err3, linkEnded: h3?.dead ?? null }, linksCounted: count(r) }
    if (pol === 'strict') check('until, strict: a thing that cannot say it already closed is refused bad-target', err2 === 'bad-target' && err3 === 'bad-target' && count(r) === 0, saw)
    else limit('until, loose: a plain EventEmitter or a MessagePort that already closed is taken, and the link never ends', saw)
    h2?.disconnect(); h3?.disconnect()
  }
  policy.until = 'strict'
}
// 4. once together with until
{
  const r = mk(); const em = sockLike(); let calls = 0
  const h = r.data.k1.connect(() => { calls++ }, { once: true, until: em })
  await flush()
  const left = em.listenerCount('close')
  closeIt(em)
  r.data.k1.n.set(9)
  check('once and until: one call, the until listener removed by the once, a later close does nothing', calls === 1 && left === 0 && count(r) === 0 && h.why === 'once', { calls, closeListenersLeft: left, linksCounted: count(r), endedBy: h.why })
}
// 5. a for-await loop broken with break while the same handle's callback runs
for (const brk of ['link', 'cursor']) {
  policy.brk = brk
  const r = mk(); let fnCalls = 0, loops = 0
  const h = r.data.k1.connect(() => { fnCalls++ })
  const loop = (async () => { for await (const x of h) { loops++; if (loops === 2) break } })()
  await flush(); r.data.k1.n.set(10); await flush(); await loop
  fnCalls = 0; r.data.k1.n.set(11)
  limit(`break, brk=${brk}: what the same handle's callback sees after the loop ends`, { callbackCallsAfterBreak: fnCalls, handleEnded: h.dead, linksCounted: count(r) })
  // the same, with no kept handle: for await (const x of lens.connect()) { ... break }
  const r2 = mk(); let l2 = 0
  for await (const x of r2.data.k1.connect()) { if (++l2 === 1) break }
  if (brk === 'link') check(`break, brk=${brk}: a loop over a handle nobody kept leaves no link`, count(r2) === 0, { linksLeftOpen: count(r2) })
  else limit(`break, brk=${brk}: a loop over a handle nobody kept: what is left open`, { linksLeftOpen: count(r2) })
}
policy.brk = 'link'
// 6. disconnect from inside the callback on the first call
{
  const r = mk(); let err = null, calls = 0
  try {
    const h = r.data.k1.connect((s, c) => { calls++; h.disconnect() })
  } catch (e) { err = e.constructor.name + ': ' + e.message }
  await flush()
  let writeErr = null
  try { r.data.k1.n.set(12) } catch (e) { writeErr = e.constructor.name + ': ' + e.message + (e.errors ? ' / ' + e.errors.map((x) => x.constructor.name + ': ' + x.message).join('; ') : '') }
  check('disconnect from inside the callback on its first call', err === null && writeErr === null && count(r) === 0 && calls === 1, { thrownFromConnect: err, calls, linksLeftOpen: count(r), aLaterWriteThrew: writeErr })
}
// 7. one signal for 1,000 links; each disconnected by hand first, half of them
{
  const r = mk(); const ac = new AbortController()
  const hs = []; for (let i = 0; i < 1000; i++) hs.push(r.data.k1.connect(() => {}, { signal: ac.signal }))
  await flush()
  for (let i = 0; i < 500; i++) hs[i].disconnect()
  const mid = getEventListeners(ac.signal, 'abort').length
  ac.abort()
  check('1,000 links on one signal: 500 closed by hand, then abort ends the rest', mid === 500 && count(r) === 0 && hs.every((h) => h.dead), { listenersAfter500Closed: mid, linksCounted: count(r) })
}
// 8. a callback that disconnects another link during the same commit
{
  const r = mk(); let bCalls = 0; let B = null
  const A = r.data.k1.connect((s, c) => { if (!c.first) B.disconnect() })
  B = r.data.k1.connect(() => { bCalls++ })
  await flush(); bCalls = 0
  r.data.k1.n.set(13)
  check('A disconnects B inside the same commit: B is not called for it', bCalls === 0 && count(r) === 1, { bCalls, linksCounted: count(r) })
  A.disconnect()
}
// 9. once, looped
{
  const r = mk(); let items = 0
  const loop = (async () => { for await (const x of r.data.k1.connect({ once: true })) items++ })()
  await flush(); r.data.k1.n.set(14); await flush(); await loop
  check('for await over connect({ once: true }): one item, then the loop ends', items === 1 && count(r) === 0, { items, linksCounted: count(r) })
}
// 10. until and signal on one link: the first ends it and removes the other's listener
{
  const r = mk(); const em = sockLike(); const ac = new AbortController()
  const h = r.data.k1.connect(() => {}, { until: em, signal: ac.signal })
  await flush(); ac.abort()
  check('until and signal: abort ends it and removes the close listener', h.dead && em.listenerCount('close') === 0 && count(r) === 0, { endedBy: h.why, closeListenersLeft: em.listenerCount('close') })
}
// 11. the state read after disconnect: a client's evicted rows, against a server's
{
  const srv = mk(); const cl = fero('s', { role: 'client', transport: new Loop(srv, { json: true }), linger: 0 })
  const h = cl.data.connect(); await h.ready
  const before = Object.keys(h.state).length
  const kept = h.state
  h.disconnect()
  limit('a client: the state object (a partition) a link handed out, read after the link ends', { rowsBefore: before, rowsAfterEnd: Object.keys(kept).length, k1After: kept.k1 ?? null })
}
// 12. a handle born ended (its signal already aborted): what ready, state and get() do
{
  const r = mk(); const ac = new AbortController(); ac.abort()
  const h = r.data.k1.connect(() => {}, { signal: ac.signal })
  let getErr = null; try { await getOnce(r, ['k1'], { signal: ac.signal }) } catch (e) { getErr = e.code }
  check('a link whose signal had already aborted: no selection; get() with it rejects', h.dead && count(r) === 0, { linkEnded: h.dead, linksCounted: count(r), readyResolves: await Promise.race([h.ready.then(() => true), flush().then(() => false)]), getRejects: getErr })
}
// 13. until closes while a for-await loop waits on the same handle; disconnect() before the loop starts
{
  const r = mk(); const em = sockLike(); let items = 0
  const h = r.data.k1.connect({ until: em })
  const loop = (async () => { for await (const x of h) items++ })()
  await flush(); closeIt(em)
  const ended = await Promise.race([loop.then(() => true), new Promise((res) => setTimeout(() => res(false), 100))])
  const h2 = r.data.k1.connect(); h2.disconnect(); let items2 = 0
  for await (const x of h2) items2++
  check('until closes while a loop waits: the loop ends; a loop over a handle already ended gets nothing', ended && items === 1 && items2 === 0 && count(r) === 0, { loopEnded: ended, items, itemsAfterDisconnect: items2, linksCounted: count(r) })
}
// 14. the callback aborts its own link's signal on its first call (an end from inside, by the lifetime)
{
  const r = mk(); const ac = new AbortController(); let calls = 0
  const h = r.data.k1.connect(() => { calls++; ac.abort() }, { signal: ac.signal })
  await flush(); r.data.k1.n.set(15)
  check('the callback aborts its own signal on its first call: one call, then ended', calls === 1 && h.dead && h.why === 'signal' && count(r) === 0, { calls, endedBy: h.why, linksCounted: count(r) })
}
// 15. every commit "from now": writes made in the same job right after connect() returns, before the first call
{
  const r = mk(); const items = []
  const h = r.data.k1.connect({ from: 'now' })
  r.data.k1.n.set(16); r.data.k1.n.set(17) // two commits, in the same job as connect()
  const loop = (async () => { for await (const { commit } of h) { items.push({ first: commit.first, n: commit.changes.map((d) => d.row?.n) }); if (items.length === 2) break } })()
  await flush(); r.data.k1.n.set(18); await flush(); await loop
  limit('from "now": two commits made after connect() returns but before the loop starts are folded into the loop\'s first picture, not seen one by one (this prototype keeps commits only for loops that exist; a real `from` is a log position)', { items })
}
for (const c of cases) out(c.limit ? { case: c.name, limit: true, saw: c.saw } : { case: c.name, ok: c.ok, saw: c.saw })
const ck = cases.filter((c) => !c.limit)
out({ part: 'summary', checks: ck.length, passed: ck.filter((c) => c.ok).length, failed: ck.filter((c) => !c.ok).map((c) => c.name), limits: cases.length - ck.length, counts })
