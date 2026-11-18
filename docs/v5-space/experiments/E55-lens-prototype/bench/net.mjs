// [net] claims: a server in a worker thread, a client in this thread, a real MessagePort, JSON text frames.
//   node --expose-gc --experimental-strip-types net.mjs <part> [args]
// reconnect (7)  seeded schedules: writes (some in one commit), connects and closes on the client, and
//                disconnects with writes while down; after each step every sink must equal the server
//                (a resume from the server's ring of recent frames, or a new picture when the cursor fell out)
// share (9)      1,000 here()s and 1,000 connects on one selection: SUBs the server saw, frames decoded here
// pushdown (16)  room.gt('stars', t).za('stars', 10): the view on the server (class B pushed down) against the
//                whole room held and the view run here (the first build). Rooms of 1e2-1e5 rows, 1-1,000 shapes
// miss (20)      100,000 `await client.data[k].get()` on rows not held: trips, what stays held, heap
import { fero, D, HOT } from '../proto/lens.mjs'
import { startServer, PortTransport } from '../proto/net.mjs'
import { rng, out, r1, r3, med, gcAsync } from './common.mjs'

const PART = process.argv[2]
const J = JSON.stringify
const turn = () => new Promise((r) => setImmediate(r))

if (PART === 'reconnect') {
  const SEEDS = +(process.argv[3] ?? 200)
  const tot = { seeds: 0, steps: 0, sinks: 0, disconnects: 0, resumes: 0, pictures: 0, doubled: 0, missed: 0, phantom: 0, unequal: 0, failedSeeds: [] }
  const FIRST = +(process.argv[4] ?? 1) // run seeds FIRST..FIRST+SEEDS-1 (to look at one seed)
  const TRACE = process.env.E55_TRACE === '1'
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const r = rng(seed), pick = (a) => a[r() % a.length], chance = (p) => r() % 1000 < p * 1000
    const rows = {}; let next = 0, wid = 0
    for (let i = 0; i < 10; i++) rows['k' + next++] = { n: r() % 100, s: r() % 5 }
    const server = await startServer({ depth: 1, seed: rows, ring: 1 + (r() % 8) }) // a small ring: some resumes fall out of it
    const tr = new PortTransport(server)
    const cl = fero('s', { role: 'client', transport: tr })
    const ctl = new PortTransport(server); ctl.bind({})
    const sinks = []
    const fail = { doubled: 0, missed: 0, phantom: 0, unequal: 0 } // phantom: an update that changes nothing (a frame applied twice)
    const apply = (t, c) => {
      if (c.first) { t.map.clear(); for (const ch of c.changes) t.map.set(ch.key, ch.row); return }
      for (const ch of c.changes) {
        if (ch.op === 'add') { if (t.map.has(ch.key)) fail.doubled++; t.map.set(ch.key, ch.row) }
        else if (ch.op === 'update') { if (!t.map.has(ch.key)) fail.missed++; else if (J(t.map.get(ch.key)) === J(ch.row)) { fail.phantom++; if (TRACE) console.error('PHANTOM', ch.key, J(ch.row), 'path', t.path, 'sels', [...cl.eng.sels.keys()], 'all', !!cl.eng.all, 'stats', J(tr.stats)) } t.map.set(ch.key, ch.row) }
        else { if (!t.map.has(ch.key)) fail.missed++; t.map.delete(ch.key) }
      }
    }
    const connect = () => { const path = chance(0.3) ? [] : ['k' + (r() % (next + 1))]; const t = { map: new Map(), path, alive: true }; t.link = cl.data.at(...path).connect(t, apply); sinks.push(t) }
    const writes = () => {
      const ws = []
      const n = chance(0.3) ? 2 + (r() % 4) : 1
      for (let i = 0; i < n; i++) {
        const a = r() % 100, k = 'k' + (r() % next)
        // w: every write's content is new, so an update that changes nothing can only be a frame applied twice
        if (a < 40) ws.push({ path: [k], v: { n: r() % 100, s: r() % 5, w: ++wid } })
        else if (a < 70) ws.push({ path: ['k' + next++], v: { n: r() % 100, s: r() % 5, w: ++wid } })
        else ws.push({ path: [k], rm: 1 })
      }
      return ctl.batch(ws)
    }
    for (let i = 0; i < 3; i++) connect()
    let down = false
    for (let step = 0; step < 60; step++) {
      const a = r() % 100
      if (a < 50) await writes()
      else if (a < 65) connect()
      else if (a < 75) { const live = sinks.filter((s) => s.alive); if (live.length) { const t = pick(live); t.alive = false; t.link.close() } }
      else if (a < 85 && !down) { tr.disconnect(); down = true; tot.disconnects++ }
      else if (down) { tr.reconnect(); down = false }
      else await writes()
      if (down) continue
      await tr.sync() // every frame sent before this answer has been applied here
      const { rows: srvRows } = await server.dump()
      for (const t of sinks) {
        if (!t.alive || !t.link.attached) continue
        const want = t.path.length === 0 ? Object.entries(srvRows) : srvRows[t.path[0]] !== undefined ? [[t.path[0], srvRows[t.path[0]]]] : []
        if (want.length !== t.map.size || want.some(([k, v]) => J(t.map.get(k)) !== J(v))) { fail.unequal++; if (TRACE) console.error('UNEQUAL step', step, 'path', t.path, 'want', J(want), 'got', J([...t.map])) }
      }
      if (TRACE) console.error('step', step, 'a', a, 'down', down, 'sels', [...cl.eng.sels.keys()], 'all', !!cl.eng.all, 'covered', [...cl.eng.sels.values()].filter((s) => s.covered).map((s) => s.part))
      tot.steps++
    }
    tot.seeds++; tot.sinks += sinks.length; tot.resumes += tr.stats.resumed; tot.pictures += tr.stats.pictures
    for (const k of Object.keys(fail)) tot[k] += fail[k]
    if (fail.doubled + fail.missed + fail.phantom + fail.unequal > 0 && tot.failedSeeds.length < 10) tot.failedSeeds.push(seed)
    await server.stop()
  }
  out({ claim: 7, bench: 'net-reconnect', ...tot })
  process.exit(0)
}

if (PART === 'share') {
  const seed = {}; for (let i = 0; i < 1000; i++) seed['k' + i] = { n: i }
  const server = await startServer({ depth: 1, seed })
  const tr = new PortTransport(server)
  const cl = fero('s', { role: 'client', transport: tr })
  const ctl = new PortTransport(server); ctl.bind({})
  const helds = [], targets = []
  for (let i = 0; i < 1000; i++) helds.push(cl.data.k7.here())
  for (let i = 0; i < 1000; i++) { const t = { n: 0, text: '' }; targets.push(t); cl.data.k7.connect(t, (t, c) => { t.n++; t.text = c.text() }) }
  await helds[0].ready
  await tr.sync()
  const s0 = { ...tr.stats }, e0 = { ...cl.eng.stats }
  const W = 200
  for (let i = 0; i < W; i++) ctl.write(['k7', 'n'], 1e6 + i)
  await ctl.sync(); await tr.sync()
  const { st } = await server.stats()
  out({ claim: 9, bench: 'net-share', links: 2000, writes: W, serverSubs: st.subs, serverEncodes: st.encodes, framesToThisClient: tr.stats.frames - s0.frames, decodesHere: tr.stats.decodes - s0.decodes - (tr.stats.rpc - s0.rpc), textBuildsHere: cl.eng.stats.texts - e0.texts, everyTargetCurrent: targets.every((t) => t.n === W + 1) })
  await server.stop(); process.exit(0)
}

// a client-side selection of a view pushed to the server: keeps the answer's rows and order (the order channel)
class ViewSel {
  constructor(part, ops) { this.part = part; this.ops = ops; this.seq = 0; this.ready = false; this.dropped = false; this.covered = false; this.rows = new Map(); this.order = []; this.scalar = undefined; this.wait = null }
  get readyP() { return this.ready ? Promise.resolve() : new Promise((r) => (this.wait = r)) }
  apply(x) {
    const k = x[1][1]
    if (x[1][0] === '$') { this.scalar = x[2]; return }
    if (x[0] === HOT.insert) { this.rows.set(k, x[2]); if (x[3] !== undefined) this.order.splice(x[3], 0, k); else this.order.push(k) }
    else if (x[0] === HOT.remove) { if (x[1].length > 2) return; this.rows.delete(k); const i = this.order.indexOf(k); if (i >= 0) this.order.splice(i, 1) }
    else if (x[0] === HOT.update) { if (x[1].length === 2) this.rows.set(k, x[2]); else { const row = { ...this.rows.get(k) }; row[x[1][2]] = x[2]; this.rows.set(k, row) } }
    else if (x[0] === 3) { const i = this.order.indexOf(k); this.order.splice(i, 1); this.order.splice(x[3], 0, k) }
  }
  onPicture(recs) { this.rows.clear(); this.order = []; for (const x of recs) this.apply(x) }
  onFrame(recs) { for (const x of recs) this.apply(x) }
  becameReady() { this.ready = true; this.wait?.() }
  answer() { return J(this.order.map((k) => [k, this.rows.get(k)])) }
}

if (PART === 'pushdown') {
  const P = +process.argv[3], S = +process.argv[4], MODE = process.argv[5] // MODE: push | local
  const W = +(process.argv[6] ?? 2000)
  const seedFn = `() => { let s = ${P * 7 + S}; const r = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff); const room = {}; for (let i = 0; i < ${P}; i++) room['m' + i] = { stars: r() % 1000000, text: 'hello world ' + i }; return { room } }`
  const server = await startServer({ depth: 2, seedFn })
  const tr = new PortTransport(server)
  const cl = fero('s', { depth: 2, role: 'client', transport: tr })
  const ctl = new PortTransport(server); ctl.bind({})
  const thresholds = Array.from({ length: S }, (_, i) => Math.floor((i * 1000000) / (S + 1)))
  const shape = (t) => [['gt', ['stars', t]], ['za', ['stars', 10]]]
  await server.gc(); const heap0 = (await server.stats()).heap
  await server.resetStats()
  const t0 = performance.now()
  let views
  if (MODE === 'push') {
    views = thresholds.map((t) => new ViewSel('room', shape(t)))
    for (const v of views) tr.sub(v)
    await Promise.all(views.map((v) => v.readyP))
  } else {
    const held = cl.data.room.here()
    await held.ready
    views = thresholds.map((t) => held.gt('stars', t).za('stars', 10))
  }
  const setupMs = performance.now() - t0
  await tr.sync()
  const s1 = await server.stats()
  await server.gc(); const heap1 = (await server.stats()).heap
  const pictureBytes = s1.st.pictureBytes
  await server.resetStats()
  const c0 = { ...tr.stats }
  const r = rng(P + S)
  for (let i = 0; i < W; i++) ctl.write(['room', 'm' + (r() % P), 'stars'], r() % 1000000)
  await ctl.sync(); await tr.sync()
  const { st } = await server.stats()
  const frames = tr.stats.frames - c0.frames, cpu = tr.stats.cpuNs - c0.cpuNs, bytes = tr.stats.bytes - c0.bytes
  // the answers, against the same view built on the server's own rows after the run
  const { rows } = await server.dump()
  const check = views.slice(0, 5).map((v, i) => {
    const got = MODE === 'push' ? v.answer() : J(v.node.currentOrder().map((k) => [k, v.node.snapshot().get(k)]))
    const want = Object.entries(rows.room).filter(([, x]) => x.stars > thresholds[i]).sort((a, b) => b[1].stars - a[1].stars).slice(0, 10)
    return got === J(want)
  })
  out({ claim: 16, bench: 'pushdown', mode: MODE, roomRows: P, shapes: S, writes: W, setupMs: r1(setupMs), firstPictureBytes: pictureBytes, firstPictureBytesPerShape: Math.round(pictureBytes / (MODE === 'push' ? S : 1)), serverHeapPerShapeB: MODE === 'push' ? Math.round((heap1 - heap0) / S) : null, perChange: { serverNs: Math.round(st.cpuNs / W), serverEncodes: r3(st.encodes / W), wireBytes: r1(bytes / W), frames: r3(frames / W), clientNs: Math.round(cpu / W) }, serverNsPerView: MODE === 'push' ? r3(st.cpuNs / W / S) : null, answersRight: check.every(Boolean) })
  await server.stop(); process.exit(0)
}

if (PART === 'miss') {
  const N = 100000
  const seed = {}; for (let i = 0; i < N; i++) seed['k' + i] = { n: i, name: 'user-' + i }
  const server = await startServer({ depth: 1, seed })
  const tr = new PortTransport(server)
  const cl = fero('s', { role: 'client', transport: tr })
  await gcAsync(); const h0 = process.memoryUsage().heapUsed
  const t0 = performance.now()
  let sum = 0
  for (let i = 0; i < N; i++) { const v = await cl.data['k' + i].get(); sum += v.n }
  const ms = performance.now() - t0
  await gcAsync(); const h1 = process.memoryUsage().heapUsed
  const { st } = await server.stats()
  out({ claim: 20, bench: 'miss', reads: N, serverGets: st.gets, serverSubs: st.subs, clientSelections: cl.eng.sels.size, cacheRows: cl.eng.src.rowCount(), heapDeltaB: h1 - h0, usPerRead: r1((ms * 1000) / N), getsBehindSeen: tr.stats.getsBehind + st.getsBehind, sumRight: sum === (N * (N - 1)) / 2 })
  await server.stop(); process.exit(0)
}
