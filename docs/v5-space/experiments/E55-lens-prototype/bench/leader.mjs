// Claim 18: a method called on a path reaches that path's leader. N server workers (3 or 5), each a lens.mjs
// server Resource with the same rows; every partition (a row, depth 1) has one leader, chosen by a table. Only
// the leader commits a write to its partition; a server that is not the leader forwards the write (one more trip).
// The client keeps a copy of the table. Real MessagePorts between the client and each server, and between servers.
//   node --experimental-strip-types leader.mjs <servers>
// Measured: trips per call (client→server, server→server), commits per call, redirects:
//   (1) path calls with a fresh table; (2) after leader changes the client does not know of: the first call on a
//   moved partition, then the next; (3) the same method with no path (the client picks any server).
import { Worker, isMainThread, parentPort, workerData, MessageChannel } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const PARTS = 300
const leaderOf0 = (p, n) => { let h = 2166136261; for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) % n }

if (!isMainThread) {
  const { fero } = await import('../proto/lens.mjs')
  const { id, n } = workerData
  const table = new Map(); for (let i = 0; i < PARTS; i++) table.set('w' + i, leaderOf0('w' + i, n))
  const seed = {}; for (let i = 0; i < PARTS; i++) seed['w' + i] = { left: 1e9 }
  const st = { calls: 0, forwardsOut: 0, forwardsIn: 0, commits: 0, redirects: 0 }
  const peers = new Map()
  let waits = new Map(), ids = 0
  // a write: committed here when this server leads the partition; else forwarded to the leader (one trip)
  const write = (path, fn) => {
    const leader = table.get(path[0])
    if (leader === id) { srv.eng.write(path, fn); st.commits++; return Promise.resolve(srv.eng.readSync(path)) }
    st.forwardsOut++
    const rid = ++ids
    return new Promise((res) => { waits.set(rid, res); peers.get(leader).postMessage(JSON.stringify({ t: 'fwd', rid, path, dec: fn.dec })) })
  }
  const dec = (n) => { const f = (v) => v - n; f.dec = n; return f }
  const srv = fero('stock', { data: seed, methods: {
    sell: { at: 'row', run: (n, ctx) => ctx.at.left.set(dec(n)) }, // on a row's path: ctx.at is the lens the call was made on
    sellAny: (a, ctx) => ctx.data[a.sku].left.set(dec(a.n)), // no path: the handler names the row itself
  } })
  srv.set = (path, v) => write(path, v) // this stand-in's writes: committed at the partition's leader
  const handle = async (port, raw) => {
    const m = JSON.parse(raw)
    if (m.t === 'call') {
      st.calls++
      if (m.path && table.get(m.path[0]) !== id) { st.redirects++; port.postMessage(JSON.stringify({ t: 'redirect', id: m.id, leader: table.get(m.path[0]) })); return }
      let v, err
      try { v = await srv.callMethod(m.name, m.arg, m.path ?? []) } catch (e) { err = e.code ?? 'error' }
      port.postMessage(JSON.stringify({ t: 'res', id: m.id, v, err }))
    } else if (m.t === 'fwd') {
      st.forwardsIn++
      srv.eng.write(m.path, dec(m.dec)); st.commits++
      port.postMessage(JSON.stringify({ t: 'fwdok', rid: m.rid, v: srv.eng.readSync(m.path) }))
    } else if (m.t === 'fwdok') { const w = waits.get(m.rid); waits.delete(m.rid); w(m.v) }
  }
  parentPort.on('message', (m) => {
    if (m.type === 'client') m.port.on('message', (raw) => handle(m.port, raw))
    else if (m.type === 'peer') { peers.set(m.id, m.port); m.port.on('message', (raw) => handle(m.port, raw)) }
    else if (m.type === 'move') { table.set(m.part, m.to); parentPort.postMessage({ type: 'moved' }) }
    else if (m.type === 'stats') { parentPort.postMessage({ type: 'stats', st: { ...st } }); for (const k of Object.keys(st)) st[k] = 0 }
  })
  parentPort.postMessage({ type: 'up' })
} else {
  const N = +process.argv[2]
  const ws = []
  for (let i = 0; i < N; i++) { const w = new Worker(fileURLToPath(import.meta.url), { workerData: { id: i, n: N }, execArgv: process.execArgv.filter((a) => !a.startsWith('--expose-gc') && !a.startsWith('--max-old')) }); await new Promise((r) => w.once('message', r)); ws.push(w) }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const ch = new MessageChannel(); ws[i].postMessage({ type: 'peer', id: j, port: ch.port1 }, [ch.port1]); ws[j].postMessage({ type: 'peer', id: i, port: ch.port2 }, [ch.port2]) }
  const ports = ws.map((w) => { const ch = new MessageChannel(); w.postMessage({ type: 'client', port: ch.port2 }, [ch.port2]); return ch.port1 })
  const ask = (w, type, extra = {}) => new Promise((r) => { const h = (m) => { if (m.type !== 'up') { w.off('message', h); r(m) } }; w.on('message', h); w.postMessage({ type, ...extra }) })
  // the client: a lens call on a path goes to the leader its table names; a redirect updates the table
  const table = new Map(); for (let i = 0; i < 300; i++) table.set('w' + i, leaderOf0('w' + i, N))
  let ids = 0
  const waits = new Map()
  for (const p of ports) p.on('message', (raw) => { const m = JSON.parse(raw); const w = waits.get(m.id); waits.delete(m.id); w(m) })
  const cst = { trips: 0, redirects: 0 }
  const send = (s, m) => { cst.trips++; const id = ++ids; m.id = id; return new Promise((r) => { waits.set(id, r); ports[s].postMessage(JSON.stringify(m)) }) }
  const callOnPath = async (path, name, arg) => {
    for (;;) {
      const m = await send(table.get(path[0]), { t: 'call', name, arg, path })
      if (m.t === 'redirect') { cst.redirects++; table.set(path[0], m.leader); continue }
      return m.err ? { refused: m.err } : m.v
    }
  }
  const callNoPath = (name, arg) => send(Math.floor(Math.random() * N), { t: 'call', name, arg })
  const sum = async () => { const ss = await Promise.all(ws.map((w) => ask(w, 'stats'))); const t = { calls: 0, forwardsOut: 0, commits: 0, redirects: 0 }; for (const s of ss) for (const k of Object.keys(t)) t[k] += s.st[k]; return t }
  const res = { servers: N }
  // (1) fresh table: 1,000 path calls
  cst.trips = 0; cst.redirects = 0
  for (let i = 0; i < 1000; i++) await callOnPath(['w' + (i % 300)], 'sell', 1)
  let s = await sum()
  res.freshTable = { calls: 1000, clientTrips: cst.trips, serverForwards: s.forwardsOut, commits: s.commits, redirects: cst.redirects, tripsPerCall: (cst.trips + s.forwardsOut) / 1000, commitsPerCall: s.commits / 1000 }
  // (2) move the leader of 30 partitions; the client's table is now stale for them
  const moved = []
  for (let i = 0; i < 30; i++) { const p = 'w' + (i * 10); const to = (table.get(p) + 1) % N; moved.push(p); for (const w of ws) await ask(w, 'move', { part: p, to }) }
  cst.trips = 0; cst.redirects = 0
  for (const p of moved) await callOnPath([p], 'sell', 1)
  s = await sum()
  res.afterMoveFirstCall = { calls: 30, clientTrips: cst.trips, redirects: cst.redirects, serverForwards: s.forwardsOut, commits: s.commits }
  cst.trips = 0; cst.redirects = 0
  for (const p of moved) await callOnPath([p], 'sell', 1)
  s = await sum()
  res.afterMoveNextCall = { calls: 30, clientTrips: cst.trips, redirects: cst.redirects, serverForwards: s.forwardsOut, commits: s.commits }
  // (3) the same work with no path: any server; it forwards the write when it does not lead the row
  cst.trips = 0
  for (let i = 0; i < 3000; i++) await callNoPath('sellAny', { sku: 'w' + (i % 300), n: 1 })
  s = await sum()
  res.noPath = { calls: 3000, clientTrips: cst.trips, serverForwards: s.forwardsOut, extraTripShare: +(s.forwardsOut / 3000).toFixed(3), expected: +((N - 1) / N).toFixed(3), commits: s.commits }
  // (4) review F8: a client picks the path. A method declared for a row is refused anywhere else, by the server
  await sum()
  let refused = 0
  const badPaths = []
  for (let i = 0; i < 100; i++) { const p = 'w' + (i % 300); badPaths.push([p, 'left']); badPaths.push([p, 'left', 'x']) }
  for (const path of badPaths) { const v = await callOnPath(path, 'sell', 1); if (v?.refused === 'bad-path') refused++ }
  const noPathSell = await send(0, { t: 'call', name: 'sell', arg: 1 }); if (noPathSell.err === 'bad-path') refused++
  const onPathSellAny = await callOnPath(['w1'], 'sellAny', { sku: 'w1', n: 1 }); if (onPathSellAny?.refused === 'bad-path') refused++
  s = await sum()
  res.badPath = { calls: badPaths.length + 2, refusedBadPath: refused, commits: s.commits }
  console.log(JSON.stringify({ exp: 'E-55', node: process.version, claim: 18, bench: 'leader', ...res }))
  for (const w of ws) await w.terminate()
}
