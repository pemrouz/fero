// E-29(b): a full disk under replication. One leader and two followers, each its own OS process on its own small
// filesystem, in the shape of E-02's pipeline (the leader batches, journals, sends the same bytes to both
// followers; a follower journals, syncs, acknowledges; a batch commits at a majority). E-02's own pipeline.ts
// throws on a short write and on a failed sync, so it cannot be filled; this one adds what a full disk needs:
// a journal that refuses cleanly (journal.mjs), a follower that stops acknowledging and says so, a resend when
// it has room again, a leader that refuses new writes with a reason, and a retention pass.
//   node b_pipeline.mjs leader   <dir> <port> <peer ports>     node b_pipeline.mjs follower <dir> <port> <id>
import net from 'node:net'
import fs from 'node:fs'
import { Journal, KIND, freeBytes } from './journal.mjs'

const [ROLE, DIR, PORT, ARG] = process.argv.slice(2)
const OPTS = { layout: 'prealloc', segBytes: 2 << 20, reserveBytes: 4 << 20 }
const BATCH = 16384, TICK = 4, MAXBACK = 256           // 16 KB every 4 ms = 4 MB/s offered; at most 256 uncommitted batches
const MB = (n) => +(n / 1048576).toFixed(1)
const say = (o) => process.stdout.write(JSON.stringify({ t: Date.now(), ...o }) + '\n')
const frame = (type, seq, commit, payload) => { const b = Buffer.allocUnsafe(13 + (payload ? payload.length : 0)); b.writeUInt32LE(b.length - 4, 0); b[4] = type; b.writeUInt32LE(seq, 5); b.writeUInt32LE(commit, 9); if (payload) payload.copy(b, 13); return b }
const reader = (sock, on) => { let buf = Buffer.alloc(0); sock.on('data', (c) => { buf = buf.length ? Buffer.concat([buf, c]) : c; while (buf.length >= 4) { const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break; on(buf[4], buf.readUInt32LE(5), buf.readUInt32LE(9), buf.subarray(13, 4 + n)); buf = buf.subarray(4 + n) } }) }
const T = { batch: 1, ack: 2, full: 3, resume: 4 }
fs.mkdirSync(DIR + '/j', { recursive: true })
const j = new Journal(DIR + '/j', { ...OPTS, statDir: DIR }); j.recover()

if (ROLE === 'follower') {
  let full = false, commit = 0, sock = null, dirty = false, fullAt = 0
  const flush = () => { if (!dirty) return; dirty = false; try { j.sync(); sock.write(frame(T.ack, j.durable, 0)) } catch (e) { say({ id: ARG, line: 'follower ' + ARG + ': sync failed, stopped for good: ' + e.code }) } }
  net.createServer((s) => {
    sock = s; s.setNoDelay(true); s.on('error', () => {})
    reader(s, (type, seq, c, payload) => {
      if (type !== T.batch) return
      commit = Math.max(commit, c)
      if (full || seq !== j.seq + 1) return                     // while full, or out of order: drop; the leader resends on resume
      try { j.write([Buffer.from(payload)], KIND.data); dirty = true; setImmediate(flush) } catch (e) {
        if (e.code !== 'disk-full') throw e
        flush(); full = true; fullAt = Date.now()
        s.write(frame(T.full, j.durable, 0))
        say({ id: ARG, line: 'follower ' + ARG + ': disk-full, stopped acknowledging at batch ' + j.durable + ' (' + MB(freeBytes(DIR)) + ' MB free, ' + MB(OPTS.reserveBytes) + ' MB is reserve); it resumes by itself when space is freed' })
      }
    })
  }).listen(Number(PORT), '127.0.0.1')
  setInterval(() => {
    if (full && freeBytes(DIR) >= OPTS.reserveBytes + 2 * OPTS.segBytes) { full = false; sock?.write(frame(T.resume, j.durable, 0)); say({ id: ARG, line: 'follower ' + ARG + ': space is back after ' + (Date.now() - fullAt) + ' ms, asking for batches from ' + (j.durable + 1) }) }
    say({ id: ARG, seq: j.seq, durable: j.durable, full, freeMB: MB(freeBytes(DIR)) })
  }, 250)
  process.on('SIGUSR2', () => { const freed = j.retain(Math.max(0, commit - 64)); say({ id: ARG, line: 'follower ' + ARG + ': retention pass freed ' + MB(freed) + ' MB' }) })
} else {
  const peers = ARG.split(',').map(Number)
  const acked = [0, 0], peerFull = [false, false], socks = []
  const sent = new Map()                                       // batches a follower may still need
  let committed = 0, offered = 0, refusedFull = 0, refusedQuorum = 0, selfFull = false, lastLine = ''
  const payload = Buffer.alloc(BATCH, 0x5a)
  const advance = () => { const d = j.durable, a = acked[0], b = acked[1]; const c = Math.max(Math.min(d, a), Math.min(Math.max(d, a), b)); if (c > committed) committed = c; const low = Math.min(acked[0], acked[1]); for (const s of sent.keys()) { if (s > low) break; sent.delete(s) } }
  const dial = (i) => { const s = net.connect(peers[i], '127.0.0.1'); s.setNoDelay(true); s.on('error', () => setTimeout(() => dial(i), 50)); s.on('connect', () => { socks[i] = s; reader(s, (type, seq) => {
    if (type === T.ack) { acked[i] = Math.max(acked[i], seq); peerFull[i] = false; advance() }
    else if (type === T.full) { acked[i] = Math.max(acked[i], seq); peerFull[i] = true; say({ line: 'leader: follower ' + (i + 1) + ' is full and has stopped acknowledging at batch ' + seq + '; ' + (peerFull[0] && peerFull[1] ? 'no majority can store new writes' : 'the other two still commit') }) }
    else if (type === T.resume) { peerFull[i] = false; let n = 0; for (let q = seq + 1; q <= j.seq; q++) { const b = sent.get(q); if (b) { s.write(frame(T.batch, q, committed, b)); n++ } } say({ line: 'leader: follower ' + (i + 1) + ' has room again, resent ' + n + ' batches from ' + (seq + 1) }) }
  }) }) }
  dial(0); dial(1)
  const refuse = (why, kind) => { if (kind === 'full') refusedFull++; else refusedQuorum++; if (lastLine !== why) { lastLine = why; say({ line: why }) } }
  setInterval(() => {
    offered++
    if (j.seq - committed >= MAXBACK) return refuse('leader: refusing writes, no-writer: ' + MAXBACK + ' batches wait for a majority (retry-after 250 ms)', 'quorum')
    let seq
    try { seq = j.write([payload], KIND.data); j.sync() } catch (e) { if (e.code !== 'disk-full') throw e; selfFull = true; return refuse('leader: refusing writes, disk-full (' + MB(freeBytes(DIR)) + ' MB free is reserve; retry-after 250 ms); a retention pass or a bigger volume fixes it', 'full') }
    if (selfFull || lastLine) { selfFull = false; lastLine = ''; say({ line: 'leader: accepting writes again at batch ' + seq }) }
    sent.set(seq, payload)
    for (const s of socks) s?.write(frame(T.batch, seq, committed, payload))
    advance()
  }, TICK)
  setInterval(() => say({ id: 0, seq: j.seq, durable: j.durable, committed, acked, offered, refusedFull, refusedQuorum, freeMB: MB(freeBytes(DIR)) }), 250)
  process.on('SIGUSR2', () => { const freed = j.retain(Math.max(0, committed - 64)); say({ line: 'leader: retention pass freed ' + MB(freed) + ' MB' }) })
}
process.on('SIGTERM', () => { try { j.sync() } catch {} j.close(); process.exit(0) })
