// E-07 (c): does a stalled main thread stop the kernel? (F-14, F-06, decision 13a)
//   node --expose-gc stall.mjs <worker|main> <busy|gc> [stallMs=5000]
// A tiny kernel holds one TCP link to a peer process (peer.mjs): it sends a heartbeat every 100 ms (a Raft
// leader's heartbeat; election.ms is 2 s, so a gap near 2 s is a false failover), and it acks each write the peer
// sends (one 100 B write a millisecond), after appending it to an in-memory log. It hands every committed write
// to the main thread for the fold, batched per event-loop turn (transferred ArrayBuffers).
//   worker  the kernel runs on a worker thread (decision 13a, M `kw`)
//   main    the kernel runs on the main thread (M `loop`), the control
// After 3 s the main thread stalls:
//   busy    a synchronous loop of stallMs (user code that never yields)
//   gc      it builds a 3e6-entry Map of small objects and forces two full GCs (global.gc), then drops it:
//           long stop-the-world GCs on the main thread's heap (the stall lasts as long as that takes)
// The peer records heartbeat arrivals and write round trips, sorted here into phases (before, stall = the stall's
// real span plus 200 ms, after); the kernel records its own timer gaps; the main thread measures how many commits queued up during the stall and how long it took
// to drain them.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const now = () => performance.timeOrigin + performance.now() // absolute ms, comparable across threads and processes

function kernel(port, postCommit) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.setNoDelay(true)
    const HB = Buffer.from([0xff, 0xff, 0xff, 0xff])
    const gaps = [] // [absolute time, gap ms] of the heartbeat timer, as this thread sees it
    const log = new Array(65536); let li = 0
    let pend = [], pendN = 0, scheduled = false
    const flush = () => { scheduled = false; if (!pendN) return; const ab = new ArrayBuffer(pendN * 100), u = new Uint8Array(ab); let o = 0; for (const b of pend) { u.set(b, o); o += b.length } pend = []; pendN = 0; postCommit(ab) }
    sock.on('connect', () => {
      let last = performance.now()
      const iv = setInterval(() => { const t = performance.now(); gaps.push([now(), t - last]); last = t; sock.write(HB) }, 100)
      let rest = null
      sock.on('data', (chunk) => {
        const b = rest ? Buffer.concat([rest, chunk]) : chunk
        let off = 0
        const acks = []
        while (b.length - off >= 100) {
          const w = Buffer.from(b.subarray(off, off + 100)) // the write's bytes, copied out of the socket buffer
          log[li++ & 65535] = w // the append (memory rung; E-02 prices the disk)
          acks.push(w.subarray(0, 4))
          pend.push(w); pendN++
          off += 100
        }
        rest = off < b.length ? b.subarray(off) : null
        if (acks.length) sock.write(Buffer.concat(acks))
        if (!scheduled && pendN) { scheduled = true; setImmediate(flush) }
      })
      sock.on('close', () => { clearInterval(iv); resolve(gaps) })
    })
    sock.on('error', () => {})
  })
}

if (!isMainThread) {
  const gaps = await kernel(workerData.port, (ab) => parentPort.postMessage(ab, [ab]))
  parentPort.postMessage({ gaps })
} else {
  const [where = 'worker', kind = 'busy', STALL = '5000'] = process.argv.slice(2)
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; srv.close()
  const t0 = now() + 1500, stallAt = t0 + 3000
  const peer = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'peer.mjs'), String(port), String(t0)], { stdio: ['pipe', 'pipe', 'inherit'] })
  let peerOut = ''; peer.stdout.on('data', (d) => (peerOut += d))
  const peerDone = new Promise((r) => peer.on('exit', () => r(JSON.parse(peerOut.trim().split('\n').pop()))))
  await new Promise((r) => setTimeout(r, 300))
  let commits = 0, inStall = false, queuedAfterStall = 0, drainStart = 0, drainMs = null
  const onCommit = (ab) => {
    commits += ab.byteLength / 100
    if (drainStart && drainMs === null) { queuedAfterStall += ab.byteLength / 100; setImmediate(() => { if (drainMs === null) drainMs = now() - drainStart }) }
  }
  let kernelGaps
  if (where === 'worker') {
    const w = new Worker(new URL(import.meta.url), { workerData: { port } })
    kernelGaps = new Promise((r) => w.on('message', (m) => { if (m instanceof ArrayBuffer) onCommit(m); else r(m.gaps) }))
  } else kernelGaps = kernel(port, onCommit)
  // the stall
  await new Promise((r) => setTimeout(r, stallAt - now()))
  inStall = true
  const s0 = now()
  let gcInfo = null
  if (kind === 'busy') { const until = performance.now() + +STALL; while (performance.now() < until) { /* user code that never yields */ } }
  else {
    const m = new Map(); for (let i = 0; i < 3e6; i++) m.set(i, { a: i, b: 'x' + (i & 1023), c: [i] })
    const g = []; for (let k = 0; k < 2; k++) { const a = performance.now(); globalThis.gc(); g.push(+(performance.now() - a).toFixed(0)) }
    gcInfo = { map: m.size, full_gc_ms: g }
  }
  const s1 = now()
  inStall = false
  drainStart = s1
  await new Promise((r) => setTimeout(r, 3000))
  peer.stdin.write('stop\n')
  const P = await peerDone
  const res = await kernelGaps
  // phases by the stall's real start and end: before [t0, s0), stall [s0, s1 + 200 ms), after
  const ph = (t) => (t < s0 ? 'before' : t < s1 + 200 ? 'stall' : 'after')
  const q = (xs, f) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2) }
  const st = (xs = []) => ({ n: xs.length, p50: q(xs, 0.5), p99: q(xs, 0.99), max: xs.length ? +Math.max(...xs).toFixed(2) : null })
  const split = (pairs) => { const o = {}; for (const [t, v] of pairs) { if (t < t0) continue; (o[ph(t)] ??= []).push(v) } return { before: st(o.before), stall: st(o.stall), after: st(o.after) } }
  const hbPairs = []; for (let i = 1; i < P.hbAt.length; i++) hbPairs.push([P.hbAt[i], P.hbAt[i] - P.hbAt[i - 1]])
  const peerRes = { heartbeat_gap_ms: split(hbPairs), write_rtt_ms: split(P.rtt), writes_sent: P.writes_sent }
  const kgap = split(res)
  console.log(JSON.stringify({
    exp: 'E-07', part: 'stall', kernel_on: where, kind, node: process.version, stall_ms: +(s1 - s0).toFixed(0), gc: gcInfo,
    kernel_timer_gap_ms: kgap,
    heartbeat_jitter_ms_in_stall: Math.max(kgap.stall.max ?? 0, peerRes.heartbeat_gap_ms.stall.max ?? 0) - 100,
    commits_to_main: commits, queued_for_main_after_stall: queuedAfterStall, main_drain_ms: drainMs === null ? null : +drainMs.toFixed(1),
    peer: peerRes,
  }))
  process.exit(0)
}
void 0
