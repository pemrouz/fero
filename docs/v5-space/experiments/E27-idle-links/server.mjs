// E-27 / E-39(b) edge server: one Node process holding many client links, plain TCP or TLS.
// Started by the orchestrator with child_process.fork (IPC), args: <port> <tcp|tls> [certDir]
//   env HIST (messages kept per room, default 64), TICKET_KEYS (hex, 48 bytes: TLS session-ticket keys, so a
//   restarted server can resume sessions issued by the one before it)
// Frames (first byte is the type; sizes are fixed):
//   1 ping   16 B  server -> client, every 30 s per link (a wheel: each second, the 1/30 of links due)
//   2 pong   16 B  client -> server
//   3 data  100 B  server -> client: u8 3, u8 0, u16 room... (bytes 0-3), u32 seq (4), u64 stamp (8, CLOCK_MONOTONIC ns), payload
//   4 hello 16 B  client -> server: u8 4, 3 pad, u32 client id, u32 room, u32 cursor (last seq seen in the room, 0 = none)
//   5 ack   16 B  server -> client, after the catch-up: u8 5, 3 pad, u32 messages replayed, u32 1 if the cursor was
//                  older than the history (a shortfall: the client would need a snapshot)
// IPC commands: {cmd:'stats'} -> memory, links, CPU; {cmd:'gc'}; {cmd:'publish', rooms, perSec, prefill} starts
// publishing perSec messages a second to each of rooms 0..rooms-1 (10 ms ticks, rooms spread over the period);
// {cmd:'stop-publish'}.
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import v8 from 'node:v8'

const [PORT, MODE = 'tcp', CERTS = ''] = process.argv.slice(2)
const HIST = +(process.env.HIST ?? 64)
const links = new Set()
const rooms = new Map() // room -> { subs: Set<socket>, seq, hist: Buffer[] }
let bytesOut = 0, hellos = 0, replayed = 0, shortfalls = 0, accepted = 0, handshakeErrors = 0
const roomOf = (r) => { let x = rooms.get(r); if (!x) { x = { subs: new Set(), seq: 0, hist: [] }; rooms.set(r, x) } return x }
const PING = Buffer.alloc(16); PING[0] = 1

const onLink = (s) => {
  accepted++
  s.setNoDelay(true)
  links.add(s)
  s.room = -1
  let rest = null
  s.on('data', (chunk) => {
    let b = rest ? Buffer.concat([rest, chunk]) : chunk, off = 0
    while (b.length - off >= 16) {
      const t = b[off]
      if (t === 2) { s.lastPong = Date.now() }
      else if (t === 4) {
        const room = b.readUInt32LE(off + 8), cursor = b.readUInt32LE(off + 12)
        const R = roomOf(room)
        // catch-up from the room's history, then live
        let n = 0, short = 0
        if (cursor > 0 || R.seq > 0) {
          const first = R.seq - R.hist.length + 1
          if (cursor + 1 < first && cursor > 0) short = 1
          const from = Math.max(cursor + 1, first)
          const parts = []
          for (let q = from; q <= R.seq; q++) parts.push(R.hist[q - first])
          if (parts.length) { const buf = Buffer.concat(parts); s.write(buf); bytesOut += buf.length; n = parts.length }
        }
        const ack = Buffer.alloc(16); ack[0] = 5; ack.writeUInt32LE(n, 4); ack.writeUInt32LE(short, 8)
        s.write(ack); bytesOut += 16
        R.subs.add(s); s.room = room
        hellos++; replayed += n; shortfalls += short
      } else { s.destroy(); return }
      off += 16
    }
    rest = off < b.length ? b.subarray(off) : null
  })
  s.on('error', () => {})
  s.on('close', () => { links.delete(s); if (s.room >= 0) rooms.get(s.room)?.subs.delete(s) })
}

let srv
if (MODE === 'tls') {
  const opts = { key: fs.readFileSync(CERTS + '/key.pem'), cert: fs.readFileSync(CERTS + '/cert.pem') }
  if (process.env.TICKET_KEYS) opts.ticketKeys = Buffer.from(process.env.TICKET_KEYS, 'hex')
  srv = tls.createServer(opts, onLink)
  srv.on('tlsClientError', () => { handshakeErrors++ })
} else srv = net.createServer(onLink)
srv.maxConnections = 50000
const startListening = () => srv.listen({ port: +PORT, host: '127.0.0.1', backlog: 4096 }, () => process.send({ ready: true }))

// heartbeat wheel: every second, ping the links whose turn it is (each link once per 30 s)
let wheel = 0
setInterval(() => {
  let i = 0
  for (const s of links) { if (i++ % 30 === wheel) { s.write(PING); bytesOut += 16 } }
  wheel = (wheel + 1) % 30
}, 1000)

// publishing
let pub = null
// Each room's seq is a function of time since EPOCH (env, ms; default: this server's start), so a restarted
// server continues the same sequences, and `prefill` gives each room the history a recovered server would hold
// (the last HIST messages), so a resubscribing client can catch up from its cursor (E-39(b)).
const EPOCH = +(process.env.EPOCH ?? Date.now())
const seqAt = (r, nRooms, perSec, t) => Math.floor(((t - EPOCH) / 1000) * perSec + r / nRooms) // rooms spread over the period
const mkMsg = (r, seq, stamp) => { const m = Buffer.allocUnsafe(100); m.fill(0x5a, 16); m[0] = 3; m[1] = 0; m.writeUInt16LE(r & 0xffff, 2); m.writeUInt32LE(seq, 4); m.writeBigUInt64LE(stamp, 8); return m }
const publish = (nRooms, perSec, prefill) => {
  if (pub) clearInterval(pub)
  const t0 = Date.now()
  for (let r = 0; r < nRooms; r++) {
    const R = roomOf(r), cur = Math.max(0, seqAt(r, nRooms, perSec, t0))
    if (prefill) { R.hist = []; for (let q = Math.max(1, cur - HIST + 1); q <= cur; q++) R.hist.push(mkMsg(r, q, 0n)) }
    R.seq = cur
  }
  pub = setInterval(() => {
    const t = Date.now(), stamp = process.hrtime.bigint()
    for (let r = 0; r < nRooms; r++) {
      const R = roomOf(r), want = seqAt(r, nRooms, perSec, t)
      while (R.seq < want) {
        const m = mkMsg(r, ++R.seq, stamp)
        R.hist.push(m); if (R.hist.length > HIST) R.hist.shift()
        for (const s of R.subs) { s.write(m); bytesOut += 100 }
      }
    }
  }, 10)
}

const cpuTicks = () => { const f = fs.readFileSync('/proc/self/stat', 'utf8'); const x = f.slice(f.lastIndexOf(')') + 2).split(' '); return +x[11] + +x[12] }
const status = () => { const t = fs.readFileSync('/proc/self/status', 'utf8'); const g = (k) => +(new RegExp(k + ':\\s+(\\d+)').exec(t)?.[1] ?? 0); return { vmrss_kb: g('VmRSS'), vmhwm_kb: g('VmHWM') } }
process.on('message', (m) => {
  if (m.cmd === 'gc') { globalThis.gc?.(); process.send({ gc: true }) }
  else if (m.cmd === 'stats') {
    const mu = process.memoryUsage(), hs = v8.getHeapStatistics()
    process.send({ stats: { links: links.size, accepted, hellos, replayed, shortfalls, handshake_errors: handshakeErrors, bytes_out: bytesOut, cpu_ticks: cpuTicks(), ...status(), rss: mu.rss, heap_used: hs.used_heap_size, external: mu.external, array_buffers: mu.arrayBuffers } })
  } else if (m.cmd === 'publish') { publish(m.rooms, m.perSec, m.prefill); process.send({ publishing: true }) }
  else if (m.cmd === 'stop-publish') { if (pub) clearInterval(pub); pub = null; process.send({ stopped: true }) }
})

// env PUBLISH="rooms,perSec": publish (with prefill) before accepting any link, as a recovered server would
if (process.env.PUBLISH) { const [r, ps] = process.env.PUBLISH.split(',').map(Number); publish(r, ps, true) }
startListening()
