// E-63: the load. One client link to the leader's kernel worker; from t0 it sends `rate` writes a second, the
// writes due every 1 ms tick in one ASK frame (at most 2,000 a tick, so a late tick is followed by a catch-up
// burst). Open loop: it never waits for answers, so a stalled server shows as writes waiting, not as writes not
// sent. It records every write's send time and its answer's arrival, and on 'phases <s0> <s1>' (stdin) prints
// one JSON line of stats split by phase.
//   node client.mjs '<cfg json>'     cfg: { ports, rate, rows, shape, t0, phases, bar }
// The mix keeps the row count flat (E-07's way): 40 % field writes, 15 % incr, 10 % conditional whole-row sets
// (half of them name the wrong region, so they are refused `conflict`), 15 % plain whole-row sets of a live row,
// 10 % plain sets of a new row, 10 % plain removes of the oldest row. Plain = 35 %.
import net from 'node:net'
import readline from 'node:readline'
import * as K from './common.mjs'

const cfg = JSON.parse(process.argv[2])
const P = cfg.phases, END = cfg.t0 + P.warm + P.steady + P.stall + P.after
const N = Math.ceil(cfg.rate * (END - cfg.t0) / 1000) + 4096
const sentAt = new Float64Array(N), ansAt = new Float64Array(N), kind = new Uint8Array(N), status = new Uint8Array(N).fill(255)
const KINDS = ['f', 'i', 'c', 's', 'ins', 'r'], PLAINK = [false, false, false, true, true, true]
let seq = 0, oldest = 0, next = cfg.rows, stamp = 1, x = 0x9e3779b9, answered = 0
const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0 } // xorshift32

// One link to each server; writes go to `cur`, the leader (server 0 at the start). On `moved` (M3's hand-over)
// the client resends every write not yet answered to the new leader, as a real client resends after a failover.
const T_MOVED = 12
let cur = 0, moved = null, resent = 0
const frames = [] // the writes of each ASK sent, kept until all are answered, for a resend
const links = cfg.ports.map((port) => {
  const sock = net.connect(port, '127.0.0.1')
  sock.setNoDelay(true)
  sock.on('error', (e) => { console.error('client link', e.message) })
  sock.on('data', K.framer((type, body) => {
    const t = K.now()
    if (type === K.T_ANS) { for (let o = 0; o + 8 <= body.length; o += 8) { const s = body.readUInt32LE(o); if (ansAt[s] === 0) { ansAt[s] = t; status[s] = body.readUInt32LE(o + 4); answered++ } } }
    else if (type === T_MOVED) {
      const to = body.readUInt32LE(0); if (to === cur) return
      cur = to; moved = t
      const again = []; for (const f of frames) for (const w of f) if (ansAt[w.q] === 0) again.push(w)
      for (let i = 0; i < again.length; i += 2000) sendAsk(again.slice(i, i + 2000))
      resent += again.length
    }
  }))
  return new Promise((r) => sock.once('connect', () => r(sock)))
})
const socks = await Promise.all(links)
const sendAsk = (ws) => { const body = Buffer.from(JSON.stringify(ws)), h = Buffer.allocUnsafe(5); h.writeUInt32LE(body.length + 1, 0); h[4] = K.T_ASK; socks[cur].write(Buffer.concat([h, body])) }

const write = () => {
  const s = seq++, m = rnd() % 100, live = next - oldest, j = oldest + (rnd() % live)
  let w, k
  if (m < 40) { k = 0; w = { q: s, o: 'f', k: K.key(j), f: 'n', v: ++stamp } }
  else if (m < 55) { k = 1; w = { q: s, o: 'i', k: K.key(j), v: 1 } }
  else if (m < 65) { k = 2; w = { q: s, o: 'c', k: K.key(j), eq: (rnd() & 0x10000) ? 'r' + (j % 16) : 'none', v: K.row(cfg.shape, j, ++stamp) } }
  else if (m < 80) { k = 3; w = { q: s, o: 's', k: K.key(j), v: K.row(cfg.shape, j, ++stamp) } }
  else if (m < 90) { k = 4; w = { q: s, o: 's', k: K.key(next), v: K.row(cfg.shape, next, ++stamp) }; next++ }
  else { k = 5; w = { q: s, o: 'r', k: K.key(oldest) }; oldest++ }
  kind[s] = k
  return w
}
// pending (sent and not answered) sampled every tick, to see when a capped client would refuse `backpressure`
const pend = []
await new Promise((resolve) => {
  const tick = () => {
    const t = K.now()
    if (t >= END) return resolve()
    const due = t < cfg.t0 ? 0 : Math.min(2000, Math.floor((t - cfg.t0) * cfg.rate / 1000) - seq)
    if (due > 0) {
      const ws = new Array(due); for (let i = 0; i < due; i++) ws[i] = write()
      const ts = K.now(); for (let i = 0; i < due; i++) sentAt[ws[i].q] = ts
      sendAsk(ws); frames.push(ws)
    }
    while (frames.length && frames[0].every((w) => ansAt[w.q] !== 0)) frames.shift()
    pend.push([t, seq - answered])
    setTimeout(tick, 1)
  }
  setTimeout(tick, Math.max(0, cfg.t0 - K.now()))
})

// drain: wait until every write is answered, or 30 s past the end
await new Promise((resolve) => { const chk = () => (answered >= seq || K.now() > END + 30000 ? resolve() : setTimeout(chk, 20)); chk() })
console.log(JSON.stringify({ client_done: seq, answered, drained_after_end_ms: +(K.now() - END).toFixed(0) }))
const [s0, s1] = await new Promise((res) => readline.createInterface({ input: process.stdin }).on('line', (l) => { const [c, a, b] = l.trim().split(' '); if (c === 'phases') res([+a, +b]) }))

// ── stats ──
const ws = cfg.t0 + P.warm, BAR = cfg.bar
const lat = (from, to, filter = () => true) => { // writes sent in [from, to): latency of the answered ones
  const all = [], pl = [], ju = []; let un = 0, refused = 0, sent = 0
  for (let s = 0; s < seq; s++) {
    if (sentAt[s] < from || sentAt[s] >= to || !filter(s)) continue
    sent++
    if (ansAt[s] === 0) { un++; continue }
    const l = ansAt[s] - sentAt[s]; all.push(l); (PLAINK[kind[s]] ? pl : ju).push(l)
    if (status[s] !== K.OK) refused++
  }
  return { sent, unanswered: un, refused, all: K.st(all), plain: K.st(pl), judged: K.st(ju) }
}
const steady = lat(ws, s0 - 200) // writes sent at least 200 ms before the stall
// the stall: writes sent during it, and which were answered before it ended
const stall = { sent: 0, plain_sent: 0, judged_sent: 0, answered_in_stall: 0, plain_answered_in_stall: 0, judged_answered_in_stall: 0, ok_in_stall: 0 }
const inStallLat = []
for (let s = 0; s < seq; s++) {
  if (sentAt[s] < s0 || sentAt[s] >= s1) continue
  const pl = PLAINK[kind[s]]; stall.sent++; pl ? stall.plain_sent++ : stall.judged_sent++
  if (ansAt[s] !== 0 && ansAt[s] < s1) { stall.answered_in_stall++; pl ? stall.plain_answered_in_stall++ : stall.judged_answered_in_stall++; if (status[s] === K.OK) stall.ok_in_stall++; inStallLat.push(ansAt[s] - sentAt[s]) }
}
stall.latency_answered_in_stall = K.st(inStallLat)
const stallAll = lat(s0, s1)
stall.latency_all_sent_in_stall = stallAll.all
if (moved) stall.latency_sent_after_moved = lat(moved, s1).all // M3: writes sent to the new leader while the old one's main was still stalled
stall.unanswered_at_end = stallAll.unanswered
// the longest time with no answer at all, from s0 to s1
{ let lastA = s0, gap = 0; const as = []; for (let s = 0; s < seq; s++) if (ansAt[s] >= s0 && ansAt[s] < s1) as.push(ansAt[s]); as.sort((a, b) => a - b); for (const a of as) { gap = Math.max(gap, a - lastA); lastA = a } gap = Math.max(gap, s1 - lastA); stall.longest_no_answer_ms = +gap.toFixed(1) }
// pending writes: the most during the stall, and how long after s0 a client capped at 512 would have refused
let maxPend = 0, to512 = null
for (const [t, n] of pend) { if (t >= s0 && t < s1 + 200) { if (n > maxPend) maxPend = n; if (n >= 512 && to512 === null) to512 = +(t - s0).toFixed(1) } }
stall.max_pending = maxPend; stall.ms_to_512_pending = to512
// recovery: after s1, the first 100 ms bin of sends from which every later bin's p99 is under the bar; and when the
// last write sent during the stall was answered
const after = lat(s1, END)
const binsAfter = []
for (let b = s1; b < END - 100; b += 100) { const r = lat(b, b + 100); binsAfter.push([b - s1, r.all.p99 ?? Infinity, r.unanswered]) }
const backUnder = (lim) => { for (let i = binsAfter.length - 1; i >= 0; i--) { if (binsAfter[i][1] > lim || binsAfter[i][2] > 0) return i + 1 < binsAfter.length ? binsAfter[i + 1][0] : null } return 0 }
const steadyLim = Math.max(BAR, steady.all.p999 ?? 0)
let lastStallAns = 0; for (let s = 0; s < seq; s++) if (sentAt[s] >= s0 && sentAt[s] < s1 && ansAt[s] > lastStallAns) lastStallAns = ansAt[s]
// timeline: sent and answered per 100 ms bin from t0
const NB = Math.ceil((END - cfg.t0 + 2000) / 100), bs = new Uint32Array(NB), ba = new Uint32Array(NB)
for (let s = 0; s < seq; s++) { bs[Math.min(NB - 1, Math.floor((sentAt[s] - cfg.t0) / 100))]++; if (ansAt[s]) ba[Math.max(0, Math.min(NB - 1, Math.floor((ansAt[s] - cfg.t0) / 100)))]++ }
console.log(JSON.stringify({
  role: 'client', sent: seq, answered, unanswered_at_end: seq - answered, rate: cfg.rate, s0, s1,
  steady, stall, moved_after_s0_ms: moved ? +(moved - s0).toFixed(1) : null, resent,
  after: { ...after, back_under_bar_ms: backUnder(BAR), back_to_steady_p99_ms: backUnder(steadyLim), last_stall_write_answered_after_ms: lastStallAns ? +(lastStallAns - s1).toFixed(1) : null },
  refused_by_status: (() => { const c = {}; for (let s = 0; s < seq; s++) if (status[s] !== K.OK && status[s] !== 255) c[status[s]] = (c[status[s]] ?? 0) + 1; return c })(),
  bins: { sent: Array.from(bs), answered: Array.from(ba) },
}))
process.exit(0)
