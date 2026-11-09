// E-08 relay in Node: one thread, plain TCP or WebSocket (E-40), optionally TLS (E-40's wss/tls rows).
//   node relay.mjs <feed_port> <sub_port> [tcp|ws] [cap_bytes=4194304] [tls=0|1]
// The same design as rs/src/bin/relay.rs. A subscriber joins one room (4 bytes: u16 room, u16 0; in ws mode the
// same 4 bytes as a masked binary frame after the HTTP upgrade). A tick is one event-loop turn (TICK=immediate, the
// default) or one read of the feed link (TICK=data, the first runs):
// its records are grouped by room, each room's bytes are copied ONCE into one Buffer (in ws mode one binary
// frame, header included), and that same Buffer is written to every subscriber of the room (one write per
// socket per tick). A subscriber whose writableLength passes cap_bytes pauses the feed until it drains.
// Two seconds after the feed link closes (or on SIGTERM) it prints one JSON line of counters and exits.
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import crypto from 'node:crypto'

const [FEED, SUBP, MODE = 'tcp', CAP = String(4 << 20), TLS = '0'] = process.argv.slice(2)
// TICK=data: fan out after every read of the feed link (each read is at most 64 KB, about 650 records): the first
// E-08 and E-40 runs. TICK=immediate (default since 2026-11-09): gather every read of one event-loop turn and fan
// out once, in setImmediate, so a busy relay batches as the Rust relay does (it reads up to 1 MB per tick).
// TICK=winN: gather for N ms after the first record of a round, then fan out once (bigger rounds, N ms more latency)
const TICK = process.env.TICK ?? 'immediate'
const WIN = TICK.startsWith('win') ? +TICK.slice(3) : 0
const cap = +CAP, ws = MODE === 'ws', useTls = TLS === '1'
const REC = 100, ROOMS = 64
const roomSubs = Array.from({ length: ROOMS }, () => new Set())
let recsIn = 0, deliveries = 0, ticks = 0, pauses = 0, drops = 0, slow = 0
let feedSock = null
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const onSub = (s) => {
  s.setNoDelay(true)
  let hello = Buffer.alloc(0), room = -1, upgraded = !ws
  const onData = (d) => {
    hello = Buffer.concat([hello, d])
    if (!upgraded) {
      const end = hello.indexOf('\r\n\r\n')
      if (end < 0) return
      const req = hello.subarray(0, end).toString('latin1')
      const key = /Sec-WebSocket-Key: *(.*)/i.exec(req)[1].trim()
      const acc = crypto.createHash('sha1').update(key + GUID).digest('base64')
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`)
      hello = hello.subarray(end + 4); upgraded = true
    }
    let p = hello
    if (ws) { // one masked client frame with a 4-byte payload: 2 B header + 4 B mask + 4 B
      if (p.length < 10) return
      const m = p.subarray(2, 6), x = Buffer.alloc(4)
      for (let i = 0; i < 4; i++) x[i] = p[6 + i] ^ m[i]
      p = x
    }
    if (p.length < 4) return
    room = p.readUInt16LE(0) % ROOMS
    roomSubs[room].add(s)
    s.off('data', onData)
    s.on('data', () => {}) // ignore anything else (pings)
  }
  s.on('data', onData)
  let over = false
  s.on('drain', () => { if (over) { over = false; if (--slow === 0) feedSock?.resume() } })
  s.markOver = () => { if (!over) { over = true; slow++; pauses++; feedSock?.pause() } }
  s.on('error', () => {})
  s.on('close', () => { if (room >= 0) roomSubs[room].delete(s); drops++; if (over) { over = false; if (--slow === 0) feedSock?.resume() } })
}

const tlsOpts = useTls ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) } : null
const subSrv = useTls ? tls.createServer(tlsOpts, onSub) : net.createServer(onSub)
subSrv.listen(+SUBP, '127.0.0.1')

const wsHeader = (len) => {
  if (len < 126) return Buffer.from([0x82, len])
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x82; h[1] = 126; h.writeUInt16BE(len, 2); return h }
  const h = Buffer.alloc(10); h[0] = 0x82; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h
}

const feedSrv = net.createServer((s) => {
  feedSock = s
  s.setNoDelay(true)
  let rest = null
  const parts = Array.from({ length: ROOMS }, () => [])
  let scheduled = false
  const fanout = () => {
    scheduled = false
    ticks++
    for (let r = 0; r < ROOMS; r++) {
      const ps = parts[r]
      if (ps.length === 0) continue
      const n = ps.length
      if (ws) ps.unshift(wsHeader(n * REC))
      const buf = Buffer.concat(ps) // the room's records, copied once, shared by every subscriber
      ps.length = 0
      for (const sub of roomSubs[r]) {
        sub.write(buf)
        deliveries += n
        if (sub.writableLength > cap) sub.markOver()
      }
    }
  }
  s.on('data', (chunk) => {
    const b = rest ? Buffer.concat([rest, chunk]) : chunk
    const whole = b.length - (b.length % REC)
    for (let off = 0; off < whole; off += REC) parts[b.readUInt16LE(off) % ROOMS].push(b.subarray(off, off + REC))
    recsIn += whole / REC
    rest = whole < b.length ? Buffer.from(b.subarray(whole)) : null
    if (TICK === 'data') fanout()
    else if (!scheduled) { scheduled = true; if (WIN) setTimeout(fanout, WIN); else setImmediate(fanout) }
  })
  s.on('error', () => {})
  s.on('close', () => setTimeout(report, 2000))
})
feedSrv.listen(+FEED, '127.0.0.1')

function report() { process.stdout.write(JSON.stringify({ relay: 'node', mode: MODE, tls: useTls, recs_in: recsIn, deliveries, ticks, pauses, drops }) + '\n', () => process.exit(0)) }
process.on('SIGTERM', report)
