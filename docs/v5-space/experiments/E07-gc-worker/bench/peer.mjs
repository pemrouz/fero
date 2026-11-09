// E-07 (c) peer: the other end of the kernel's link (a follower). From t0 it sends one 100 B write a millisecond
// (catching up if its own timer was late) and records each heartbeat's arrival time and each write's round trip
// (send to ack). On "stop" (stdin) it closes the link and prints the raw times as one JSON line; stall.mjs sorts
// them into phases with the stall's real start and end.
//   node peer.mjs <port> <t0>       (t0 is absolute ms, performance.timeOrigin + performance.now())
import net from 'node:net'
import { performance } from 'node:perf_hooks'

const [port, t0] = process.argv.slice(2).map(Number)
const now = () => performance.timeOrigin + performance.now()
const hbAt = [], rtt = []
const sentAt = new Float64Array(1 << 16)
let seq = 0, sock = null, stopped = false
const srv = net.createServer((s) => {
  sock = s
  s.setNoDelay(true)
  let rest = null
  s.on('data', (chunk) => {
    const t = now()
    const b = rest ? Buffer.concat([rest, chunk]) : chunk
    let off = 0
    for (; b.length - off >= 4; off += 4) {
      const v = b.readUInt32LE(off)
      if (v === 0xffffffff) hbAt.push(+t.toFixed(2))
      else rtt.push([+sentAt[v & 0xffff].toFixed(2), +(t - sentAt[v & 0xffff]).toFixed(3)])
    }
    rest = off < b.length ? b.subarray(off) : null
  })
  s.on('error', () => {})
  const w = Buffer.alloc(100, 0x5a)
  const tick = () => {
    if (stopped) return
    const t = now()
    const due = t < t0 ? 0 : Math.floor(t - t0) - seq
    const bufs = []
    for (let i = 0; i < due; i++) { const x = Buffer.from(w); x.writeUInt32LE(seq, 0); sentAt[seq & 0xffff] = now(); seq++; bufs.push(x) }
    if (bufs.length) s.write(Buffer.concat(bufs))
    setTimeout(tick, 1)
  }
  tick()
})
srv.listen(port, '127.0.0.1')
process.stdin.on('data', () => {
  stopped = true
  setTimeout(() => { sock?.end(); srv.close(); process.stdout.write(JSON.stringify({ hbAt, rtt, writes_sent: seq }) + "\n", () => process.exit(0)) }, 100)
})
