// E-27 / E-39(b) client process: holds n links to the edge server (server.mjs), plain TCP or TLS.
// Forked with IPC; args: <port> <tcp|tls> <n> <firstId> <roomMod> [policy=none|fixed|jitter] [concurrency=200] [active]
// Link i (id = firstId + i) joins room id % roomMod (or, if id >= active, a room of its own that never gets
// traffic: 1,000,000 + id) with a hello carrying its cursor (the last seq it saw in
// the room). It answers pings, records the latency of every data message (now - stamp, CLOCK_MONOTONIC), and
// moves its cursor. If the link closes: policy none = stay down; fixed = redial every 20 ms; jitter = redial
// after a full-jitter exponential backoff (random in [0, min(3 s, 50 ms * 2^attempt)]). On TLS it offers the
// last session ticket it received (env RESUME=1), so a server with the same ticket keys can resume without a
// full handshake.
// IPC: {cmd:'stats'} -> counts, latency summary, resubscribe times; {cmd:'reset'} clears the latency histogram.
import net from 'node:net'
import tls from 'node:tls'

const [PORT, MODE, N, FIRST, ROOMMOD, POLICY = 'none', CONC = '200', ACTIVE = '1e12'] = process.argv.slice(2)
const n = +N, first = +FIRST, roomMod = +ROOMMOD, conc = +CONC, active = +ACTIVE
const RESUME = process.env.RESUME === '1' // offer the last session ticket when dialing (TLS resumption)
const PONG = Buffer.alloc(16); PONG[0] = 2
let connected = 0, subscribed = 0, dialing = 0, dialErrors = 0, resumed = 0, fullHandshakes = 0, msgs = 0, bytesIn = 0, replayedIn = 0, shortfalls = 0
let session = null
const H = new Float64Array(64 * 8) // latency histogram: 8 buckets per power of two of microseconds
let hN = 0, hMax = 0
const hAdd = (us) => { const v = Math.max(1, us); const i = Math.min(H.length - 1, Math.floor(Math.log2(v) * 8)); H[i]++; hN++; if (us > hMax) hMax = us }
const hQ = (f) => { const t = Math.ceil(f * hN); let a = 0; for (let i = 0; i < H.length; i++) { a += H[i]; if (a >= t && t > 0) return +Math.pow(2, (i + 1) / 8).toFixed(0) } return null }
const subAt = [] // [absolute ms when the link's hello was acked, attempts it took]
const st = Array.from({ length: n }, (_, i) => ({ id: first + i, room: first + i < active ? (first + i) % roomMod : 1e6 + first + i, cursor: 0, attempt: 0, sock: null }))
const now = () => performance.timeOrigin + performance.now()

const queue = [] // links waiting to dial, under the concurrency limit
const pump = () => { while (dialing < conc && queue.length) dial(queue.shift()) }
const later = (L) => {
  if (POLICY === 'none') return
  L.attempt++
  const d = POLICY === 'fixed' ? 20 : Math.random() * Math.min(3000, 50 * 2 ** L.attempt)
  setTimeout(() => { queue.push(L); pump() }, d)
}
function dial(L) {
  dialing++
  let done = false
  const s = MODE === 'tls'
    ? tls.connect({ port: +PORT, host: '127.0.0.1', rejectUnauthorized: false, session: RESUME ? session ?? undefined : undefined })
    : net.connect(+PORT, '127.0.0.1')
  const up = () => {
    if (done) return; done = true; dialing--; pump()
    connected++; L.up = true
    if (MODE === 'tls') { if (s.isSessionReused()) resumed++; else fullHandshakes++ }
    s.setNoDelay(true)
    const h = Buffer.alloc(16); h[0] = 4; h.writeUInt32LE(L.id, 4); h.writeUInt32LE(L.room, 8); h.writeUInt32LE(L.cursor, 12)
    s.write(h)
  }
  if (MODE === 'tls') { s.once('secureConnect', up); s.on('session', (x) => { session = x }) } else s.once('connect', up)
  L.sock = s
  let rest = null, isSub = false
  s.on('data', (chunk) => {
    bytesIn += chunk.length
    const b = rest ? Buffer.concat([rest, chunk]) : chunk
    let off = 0
    const t = process.hrtime.bigint()
    for (;;) {
      if (b.length - off < 1) break
      const ty = b[off], size = ty === 3 ? 100 : 16
      if (b.length - off < size) break
      if (ty === 1) s.write(PONG)
      else if (ty === 3) { msgs++; L.cursor = b.readUInt32LE(off + 4); if (isSub) hAdd(Number(t - b.readBigUInt64LE(off + 8)) / 1000); else replayedIn++ }
      else if (ty === 5) { isSub = true; subscribed++; shortfalls += b.readUInt32LE(off + 8); subAt.push([+now().toFixed(1), L.attempt]); L.attempt = 0 }
      off += size
    }
    rest = off < b.length ? b.subarray(off) : null
  })
  s.on('error', () => { if (!done) { done = true; dialing--; dialErrors++; pump() } })
  s.on('close', () => {
    if (!done) { done = true; dialing--; pump() }
    if (L.sock !== s) return
    if (isSub) subscribed--
    if (L.up) { connected--; L.up = false }
    L.sock = null
    later(L)
  })
}
for (const L of st) queue.push(L)
pump()

process.on('message', (m) => {
  if (m.cmd === 'stats') {
    process.send({ stats: { connected, subscribed, dial_errors: dialErrors, resumed, full_handshakes: fullHandshakes, msgs, replayed_in: replayedIn, shortfalls, bytes_in: bytesIn,
      lat_us: { n: hN, p50: hQ(0.5), p99: hQ(0.99), p999: hQ(0.999), max: +hMax.toFixed(0) }, sub_at: m.withTimes ? subAt : subAt.length } })
  } else if (m.cmd === 'reset') { H.fill(0); hN = 0; hMax = 0; subAt.length = 0; process.send({ reset: true }) }
})
