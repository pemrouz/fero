// E-40 server: the other end of the prototype client (client/fero-client.ts), in Node, over WebSocket + TLS.
//   node --experimental-strip-types server.mjs <wssPort> <httpPort> <staticDir> [rows=100]
// wss://127.0.0.1:<wssPort>/ws  the fero wire (see fero-client.ts): challenge on upgrade, the door (HMAC-SHA-256
//                               of the nonce with the project secret), follow with a cursor (a snapshot frame of
//                               `rows` inserts as seq 0, then each commit), writes committed in memory (seq + 1,
//                               the records to every follower, then "committed" to the writer).
// http://127.0.0.1:<httpPort>/  static files for the browser runs (the page and the bundles), on another origin
//                               so the page's own connection never carries the WebSocket's TLS handshake.
// The commit here is in memory: E-01's C (0.73 ms) and E-02's pipeline are the replicated commit's cost.
// Prints "ready" on stdout.
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encodeFrame } from '../../../../kernel/codec.ts'

const [WSS, HTTP, STATIC, ROWS = '100'] = process.argv.slice(2)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const CERTS = process.env.CERTS || `${SP}/e40/certs`
const SECRET = 'e40-secret'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const rows = []
for (let i = 0; i < +ROWS; i++) rows.push({ type: 1, key: [], at: 'k' + i, value: { name: 'user-' + i, room: i % 10, n: 0 } })
const res = { seq: 0, snapshot: encodeFrame(rows), followers: new Set() }

const frame = (payload) => { // an unmasked server frame, opcode 2 (binary)
  const n = payload.length
  const h = n < 126 ? Buffer.from([0x82, n]) : n < 65536 ? Buffer.from([0x82, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x82; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b })()
  return Buffer.concat([h, payload])
}
const msg = (type, ...parts) => frame(Buffer.concat([Buffer.from([type]), ...parts.map((p) => Buffer.from(p.buffer ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : p))]))
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

function onUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key']
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64')
  sock.setNoDelay(true)
  const nonce = crypto.randomBytes(32)
  // the 101 and the challenge leave in one write: the challenge costs no extra round trip
  sock.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`), msg(1, nonce)]))
  let buf = Buffer.alloc(0), admitted = false
  const handle = (p) => {
    const t = p[0]
    if (t === 2) {
      const want = crypto.createHmac('sha256', SECRET).update(nonce).digest()
      if (!crypto.timingSafeEqual(want, p.subarray(1, 33))) { sock.end(msg(9, Buffer.from('door'))); return }
      admitted = true
      sock.write(msg(3))
    } else if (!admitted) { sock.end(msg(9, Buffer.from('door'))); return }
    else if (t === 4) { // follow: snapshot as seq 0 (a real server sends only what the cursor lacks), then live
      res.followers.add(sock)
      sock.write(msg(5, u32(0), res.snapshot))
    } else if (t === 6) { // write: commit (in memory), records to every follower, then "committed" to the writer
      const id = p.readUInt32LE(1)
      const seq = ++res.seq
      const out = msg(5, u32(seq), p.subarray(5))
      for (const f of res.followers) f.write(out)
      sock.write(msg(7, u32(id), u32(seq)))
    }
  }
  sock.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 15, masked = buf[1] & 128
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const need = off + (masked ? 4 : 0) + len
      if (buf.length < need) return
      let p = buf.subarray(off + (masked ? 4 : 0), need)
      if (masked) { const m = buf.subarray(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3] }
      buf = buf.subarray(need)
      if (op === 8) { sock.end(); return }
      if (op === 2) handle(p)
    }
  })
  sock.on('error', () => {})
  sock.on('close', () => res.followers.delete(sock))
}

const wss = https.createServer({ key: fs.readFileSync(CERTS + '/key.pem'), cert: fs.readFileSync(CERTS + '/cert.pem') }, (q, r) => { r.writeHead(404); r.end() })
wss.on('upgrade', onUpgrade)
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' }
const web = http.createServer((q, r) => {
  const f = path.join(STATIC, path.normalize(new URL(q.url, 'http://x').pathname).replace(/^\/+/, ''))
  if (!f.startsWith(STATIC) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return }
  r.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  r.end(fs.readFileSync(f))
})
let up = 0
const ready = () => { if (++up === 2) console.log('ready') }
wss.listen(+WSS, '127.0.0.1', ready)
web.listen(+HTTP, '127.0.0.1', ready)
