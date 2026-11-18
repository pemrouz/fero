// E-55's [net] half: a server in a worker thread and clients joined to it by real MessagePorts (JSON text
// frames, so every frame is encoded once and decoded once). The server is lens.mjs's server Resource; a client
// is lens.mjs's client Resource with a PortTransport.
//
// Wire (all JSON text):
//   client → server  {t:'sub', k, part, ops?, cur?}   one SUB per selection; ops = plain-data operators pushed to
//                                                     the server (class B); cur = resume from this seq
//                    {t:'unsub', k} | {t:'get', id, path} | {t:'write', id, path, v, rm?} | {t:'call', id, name, arg, path}
//   server → client  {"s":k,"q":seq,"p":1,"r":[…]}   a picture (p:1) or a change frame; r = records [type, path, value, at?]
//                    {t:'val'|'ack'|'res', id, v}
// One frame text per selection per commit, shared by every port subscribed to it. The server keeps the last RING
// frames per selection: a SUB with a cursor inside the ring resumes with the frames after it; else a new picture.
import { Worker, isMainThread, parentPort, workerData, MessageChannel } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { fero, D, HOT } from './lens.mjs'

const now = () => process.hrtime.bigint()

// ── the server worker ──────────────────────────────────────────────────────────────────────────────
function serve() {
  const { depth, seed, ring: RING = 64, seedFn, syncMs = 0 } = workerData
  // syncMs > 0: writes are answered at a group commit every syncMs (a stand-in for the disk sync of V5-5)
  const held = []
  if (syncMs > 0) setInterval(() => { for (const [port, text] of held.splice(0)) send(port, text) }, syncMs)
  const answer = (port, text) => { if (syncMs > 0) held.push([port, text]); else send(port, text) }
  let data = seed
  if (seedFn) data = new Function('return (' + seedFn + ')')()()
  const srv = fero('s', { depth, data })
  srv.eng.promote()
  const entries = new Map() // selection key → { ports:Set, ring:[{q,text}], floor, link|view }
  const st = { subs: 0, unsubs: 0, gets: 0, writes: 0, encodes: 0, frames: 0, sends: 0, bytes: 0, pictureBytes: 0, cpuNs: 0n, views: 0, getsBehind: 0 }
  const send = (port, text) => { port.postMessage(text); st.sends++; st.bytes += text.length }
  const broadcast = (e, q, recsText, toRing = true) => {
    const text = '{"s":' + JSON.stringify(e.k) + ',"q":' + q + ',"r":' + recsText + '}'
    st.frames++
    if (toRing) { e.ring.push({ q, text }); if (e.ring.length > RING) e.floor = e.ring.shift().q }
    for (const p of e.ports) send(p, text)
  }
  const pictureOf = (e) => {
    // the selection's rows now, as records; for a view, in its order (at = position)
    if (e.view) {
      const n = e.view[D.node], out = [], order = n.currentOrder()
      if (n.kind === 'scalar') return [[HOT.update, ['$'], e.view[D.value]]]
      if (order) { const snap = n.snapshot(); order.forEach((k, i) => out.push([HOT.insert, [e.part, k], snap.get(k), i])) }
      else n.each((k, row) => out.push([HOT.insert, [e.part, k], row]))
      return out
    }
    const path = e.part === null ? [] : [e.part]
    return srv.eng.sel(e.part).pictureDeltas().map((d) => [HOT.insert, depth === 2 ? (d.part !== undefined ? [d.part, d.key] : [e.part, d.key]) : [d.key], d.row])
  }
  const entry = (k, part, ops) => {
    let e = entries.get(k)
    if (e) return e
    e = { k, part, ports: new Set(), ring: [], floor: srv.eng.rt.seq, view: null } // the ring holds every frame after floor
    entries.set(k, e)
    if (ops && ops.length) {
      // class B pushed down: one data view per distinct shape, its wire records encoded once per change
      st.views++
      e.view = srv.localView([part], ops)
      const n = e.view[D.node]
      if (n.kind === 'scalar') {
        n.connect({ wantsOrder: false, origin: null, apply: (b) => { st.encodes++; broadcast(e, b.seq, JSON.stringify([[HOT.update, ['$'], e.view[D.value]]])) } })
      } else D.wireSink(e.view, (b) => {
        if (b.seq === 0) return // the initial snapshot: pictures are made per subscriber
        const recs = []
        for (const x of b.records) {
          if (x.t === 'add') recs.push(x.at === undefined ? [HOT.insert, [part, x.k], x.v] : [HOT.insert, [part, x.k], x.v, x.at])
          else if (x.t === 'remove') recs.push(x.path?.length ? [HOT.remove, [part, x.k, ...x.path]] : [HOT.remove, [part, x.k]])
          else if (x.t === 'update') recs.push([HOT.update, x.path?.length ? [part, x.k, ...x.path] : [part, x.k], x.v])
          else if (x.t === 'move') recs.push([3, [part, x.k], x.from, x.to])
        }
        st.encodes++
        broadcast(e, b.seq, JSON.stringify(recs))
      })
    } else {
      e.link = srv.tapAt(part === null ? [] : [part], (c) => { if (c.first) return; st.encodes++; broadcast(e, c.seq, c.text()) })
    }
    return e
  }
  const onMsg = (port, raw) => {
    const t0 = now()
    const m = JSON.parse(raw)
    if (m.t === 'sub') {
      st.subs++
      const e = entry(m.k, m.part, m.ops)
      e.ports.add(port)
      const MUT = process.env.E55_MUTATE ?? '' // planted bugs (never in a measured run): 'resend' | 'floor'
      if (m.cur !== undefined && m.cur !== null && (m.cur >= e.floor || MUT === 'floor')) {
        for (const f of e.ring) if (f.q > m.cur || (MUT === 'resend' && f.q === m.cur)) send(port, f.text) // resume: the frames after the cursor
        send(port, '{"s":' + JSON.stringify(e.k) + ',"q":' + srv.eng.rt.seq + ',"resumed":1,"r":[]}')
      } else {
        const text = '{"s":' + JSON.stringify(e.k) + ',"q":' + srv.eng.rt.seq + ',"p":1,"r":' + JSON.stringify(pictureOf(e)) + '}'
        st.pictureBytes += text.length
        send(port, text)
      }
    } else if (m.t === 'unsub') { st.unsubs++; entries.get(m.k)?.ports.delete(port) }
    // a GET carries the highest position its client has seen (`seen`); the answer carries the server's (`q`).
    // A copy that is behind `seen` must wait before it answers, so a process never reads backwards (review F1).
    // This prototype has ONE server, which can never be behind its own client; it only counts (st.getsBehind).
    else if (m.t === 'get') { st.gets++; if (m.seen > srv.eng.rt.seq) st.getsBehind++; send(port, JSON.stringify({ t: 'val', id: m.id, q: srv.eng.rt.seq, v: srv.eng.readSync(m.path) ?? null })) }
    else if (m.t === 'write') {
      st.writes++
      if (m.rm) srv.remove(m.path); else srv.set(m.path, m.v)
      answer(port, JSON.stringify({ t: 'ack', id: m.id }))
    } else if (m.t === 'batch') { // several writes in one data commit (the sims use it)
      st.writes += m.w.length
      srv.eng.rt.batch(() => { for (const w of m.w) { if (w.rm) srv.remove(w.path); else srv.set(w.path, w.v) } })
      send(port, JSON.stringify({ t: 'ack', id: m.id }))
    } else if (m.t === 'sync') send(port, JSON.stringify({ t: 'ack', id: m.id, seq: srv.eng.rt.seq }))
    st.cpuNs += now() - t0
  }
  parentPort.on('message', (m) => {
    if (m.type === 'port') { const port = m.port; port.on('message', (raw) => onMsg(port, raw)); port.on('close', () => { for (const e of entries.values()) e.ports.delete(port) }) }
    else if (m.type === 'drop') { for (const e of entries.values()) e.ports.delete(m.port) }
    else if (m.type === 'stats') parentPort.postMessage({ type: 'stats', st: { ...st, cpuNs: Number(st.cpuNs) }, heap: process.memoryUsage().heapUsed })
    else if (m.type === 'dump') {
      const rows = depth === 1 ? Object.fromEntries(srv.eng.src.snapshot()) : Object.fromEntries([...srv.eng.parts].map(([p, s]) => [p, Object.fromEntries(s.snapshot())]))
      parentPort.postMessage({ type: 'dump', rows, seq: srv.eng.rt.seq })
    } else if (m.type === 'reset-stats') { for (const k of Object.keys(st)) st[k] = k === 'cpuNs' ? 0n : 0; parentPort.postMessage({ type: 'reset-stats' }) }
    else if (m.type === 'gc') { globalThis.gc?.(); parentPort.postMessage({ type: 'gc', heap: process.memoryUsage().heapUsed }) }
  })
  parentPort.postMessage({ type: 'up' })
}
if (!isMainThread && workerData?.e55 === 'server') serve()

// ── the main side ──────────────────────────────────────────────────────────────────────────────────
export async function startServer(opts) {
  const w = new Worker(fileURLToPath(import.meta.url), { workerData: { e55: 'server', ...opts }, execArgv: process.execArgv.filter((a) => !a.startsWith('--expose-gc') && !a.startsWith('--max-old')) }) // V8 flags are the process's; a worker sees gc too
  await new Promise((r) => w.once('message', r))
  const ask = (type, extra = {}) => new Promise((r) => { const h = (m) => { if (m.type === type) { w.off('message', h); r(m) } }; w.on('message', h); w.postMessage({ type, ...extra }) })
  return {
    worker: w,
    port() { const ch = new MessageChannel(); w.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]); return ch.port1 },
    stats: () => ask('stats'),
    dump: () => ask('dump'),
    resetStats: () => ask('reset-stats'),
    gc: () => ask('gc'),
    drop: (port) => w.postMessage({ type: 'drop' }),
    stop: () => w.terminate(),
  }
}

// a selection's key on the wire: its partition, plus the operators pushed down
export const selKey = (sel) => (sel.ops ? JSON.stringify([sel.part, sel.ops]) : sel.part === null ? '*' : String(sel.part))

export class PortTransport {
  constructor(server, { pushdown = false } = {}) {
    this.server = server; this.port = null; this.ids = 0; this.wait = new Map(); this.sels = new Map(); this.up = false
    this.stats = { subs: 0, unsubs: 0, gets: 0, decodes: 0, frames: 0, bytes: 0, cpuNs: 0, skipped: 0, pictures: 0, resumed: 0, rpc: 0, getsBehind: 0 } // frames, bytes, cpuNs: data frames only
    this.seen = 0 // the highest server position this process has seen, in any frame or answer: every GET carries it
    this.lastSeq = new Map() // partition → the newest server commit applied to it here (drops a frame seen twice)
    this.connect()
  }
  bind(client) { this.client = client }
  connect() {
    this.port = this.server.port()
    this.up = true
    const port = this.port
    port.on('message', (raw) => { if (port === this.port) this.onFrame(raw) })
  }
  disconnect() { this.up = false; this.port.close(); this.port = null; for (const [, w] of this.wait) w.reject?.(new Error('disconnected')); this.wait.clear() }
  reconnect() {
    this.connect()
    for (const [k, sel] of this.sels) if (!sel.dropped && !sel.covered) this.sendSub(sel, sel.ready ? sel.upSeq : undefined)
  }
  sendSub(sel, cur) {
    this.stats.subs++
    this.port.postMessage(JSON.stringify({ t: 'sub', k: selKey(sel), part: sel.part, ops: sel.ops, cur }))
  }
  // the cursor is the server's position (upSeq), never the local commit number (seq): a partition uncovered when
  // the whole-resource selection ends resumes from the whole's position (found by claim 7's [net] sim)
  sub(sel) { this.sels.set(selKey(sel), sel); if (this.up) this.sendSub(sel, sel.ready && sel.upSeq !== undefined ? sel.upSeq : undefined) }
  unsub(sel) { this.stats.unsubs++; this.sels.delete(selKey(sel)); if (this.up) this.port.postMessage(JSON.stringify({ t: 'unsub', k: selKey(sel) })) }
  rpc(m) { const id = ++this.ids; m.id = id; return new Promise((res, rej) => { this.wait.set(id, { res, rej }); this.port.postMessage(JSON.stringify(m)) }) }
  get(path) { this.stats.gets++; return this.rpc({ t: 'get', path, seen: this.seen }).then((m) => { if (m.q < this.seen) this.stats.getsBehind++; else this.seen = m.q; return m.v ?? undefined }) }
  write(path, v, o) { return this.rpc({ t: 'write', path, v, rm: o?.remove ? 1 : 0 }) }
  batch(ws) { return this.rpc({ t: 'batch', w: ws }) }
  sync() { return this.rpc({ t: 'sync' }) }
  call(name, arg, path) { return this.rpc({ t: 'call', name, arg, path }).then((m) => m.v) }
  onFrame(raw) {
    const t0 = now()
    const m = JSON.parse(raw)
    this.stats.decodes++
    if (m.t !== undefined) { this.stats.rpc++; const w = this.wait.get(m.id); if (w) { this.wait.delete(m.id); w.res(m) } return } // an answer: not a data frame
    this.stats.frames++; this.stats.bytes += raw.length
    if (m.q > this.seen) this.seen = m.q
    const sel = this.sels.get(m.s)
    if (sel === undefined || sel.dropped) { this.stats.cpuNs += Number(now() - t0); return }
    const e = this.client.eng
    if (m.p) {
      this.stats.pictures++
      if (sel.ops) sel.onPicture(m.r)
      else e.applyPicture(sel, m.r)
      this.markSeq(m.r, m.q, sel)
      sel.upSeq = m.q
      if (!sel.ready) sel.becameReady()
    } else if (m.resumed) { this.stats.resumed++; sel.upSeq = Math.max(sel.upSeq ?? 0, m.q) }
    else if (sel.ops) { sel.onFrame(m.r, m.q); sel.upSeq = m.q }
    else {
      // drop records this cache already applied (a partition seen through two selections around a hand-over)
      let recs = m.r
      if (process.env.E55_MUTATE_CLIENT !== 'nodedupe' && recs.some((r) => (this.lastSeq.get(r[1][0]) ?? -1) >= m.q)) { const n = recs.length; recs = recs.filter((r) => (this.lastSeq.get(r[1][0]) ?? -1) < m.q); this.stats.skipped += n - recs.length }
      if (recs.length) e.applyRecs(recs)
      this.markSeq(recs, m.q, sel)
      sel.upSeq = m.q
    }
    this.stats.cpuNs += Number(now() - t0)
  }
  markSeq(recs, q, sel) {
    if (sel.part !== null && !sel.ops) this.lastSeq.set(sel.part, q)
    for (const r of recs) if (r[1] && r[1][0] !== '$') this.lastSeq.set(r[1][0], q)
  }
}
