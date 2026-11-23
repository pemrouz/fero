// E-63: one server process of a three-copy group, with a kernel worker and a main thread.
//   node --expose-gc --experimental-strip-types server.mjs '<cfg json>'
// The kernel worker holds the links (to the other two servers and to the client), the journal (writev +
// fdatasync, group commit, E-02's), the commit rule (2 of 3 durable), heartbeats, and the answers, which it
// sends at commit. The main thread holds data's rows and folds every committed entry through data's lane (one
// lane call per entry), with a row version beside each row and the session table. Server 0 leads at the start.
// Where the leader judges writes is the form (cfg.form):
//   A     main judges, on data's rows plus an overlay of judged writes not yet folded (LAYERS 3.4's reading)
//   B     the worker judges, on its own copy of the rows (a Map of row objects plus a Map of versions) and its own
//         overlay; main only folds. Every server keeps the copy, since any copy may lead: a follower's worker
//         decodes each committed entry once more to keep its copy (DESIGN-V5 4.3's placement)
//   B2    B, with the worker's copy off the V8 heap (common.mjs CompactRows: an arena of JSON rows and an index in
//         typed arrays, versions in the index), so the kernel thread's heap stays small
//   M1    main judges, but the worker appends plain writes (a whole-row set or remove with no `if`) itself when no
//         write of the same partition is waiting at main, and tells main's overlay, in order, so later judging
//         sees them
//   M3    A, plus a watchdog: every worker pings its main every 20 ms, and a follower's ACKs (also its answer to
//         each heartbeat) say whether its main answers. When the leader's main has not answered for cfg.watchMs, the
//         worker waits until all it appended has committed and hands the leadership to a follower whose main is
//         healthy and that holds every entry (a leadership transfer), then tells the client `moved`; the client
//         resends what is unanswered there. A server whose main is stalled refuses a leadership. With no such
//         follower within cfg.watchMs, the leader leads on, as A
//   none  the control: the worker appends every write as it came, with no judging (E-07's worker)
// Added after review:
//   Bs    B, with the copy and its versions each cut into 256 Maps by the key's slot (common.mjs ShardedMap)
//   <B form>+rule    the B form, and every write also runs a user rule on the worker (a stand-in for
//         rules.write: one vm call a turn runs the turn's rules, with no time budget). The stall moves from main
//         into the rule: at the stall time one call of the rule loops for cfg.stallMs, and main does not stall
//   <B form>+budget  the same with a time budget a turn (DESIGN-V5 4.3's rule-budget, per batch, not per write):
//         the vm call has a 10 ms timeout; the write whose rule ran over is refused `rule-timeout`, and the turn's
//         later writes run again in a new call. The stall window stays cfg.stallMs from the stall's start
// The first leader's main thread stalls for cfg.stallMs at t0 + warm + steady (a busy loop: user code that
// never yields), then prints the stall's start and end (in +rule and +budget the worker's rule stalls instead). stdin: 'go <t0>' starts the run; 'phases <s0> <s1>' asks for the report.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import net from 'node:net'
import v8 from 'node:v8'
import vm from 'node:vm'
import readline from 'node:readline'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import * as K from './common.mjs'

const cfg = isMainThread ? JSON.parse(process.argv[2]) : workerData.cfg
const ID = cfg.id, FORM = cfg.form.split('+')[0], RULE = cfg.form.split('+')[1] ?? null, FIRST_LEADER = ID === 0
const OTHERS = [0, 1, 2].filter((j) => j !== ID)
const BIN = 100 // ms per timeline bin
const NB = Math.ceil((cfg.phases.warm + cfg.phases.steady + cfg.phases.stall + cfg.phases.after + 3000) / BIN)
const heapNow = () => { globalThis.gc?.(); globalThis.gc?.(); return K.mb(v8.getHeapStatistics().used_heap_size) }
const T_HELLO = 10, T_XFER = 11, T_MOVED = 12, T_XFER_NO = 13

// ═════════════════════════════════════════ kernel worker ═════════════════════════════════════════
if (!isMainThread) {
  const port = parentPort
  let t0 = 0
  const binOf = (t) => Math.max(0, Math.min(NB - 1, Math.floor((t - t0) / BIN)))
  const bins = { appended: new Uint32Array(NB), committed: new Uint32Array(NB), answered: new Uint32Array(NB) }
  let term = 1, isLeader = FIRST_LEADER, leaderId = 0, handing = false
  let lastIdx = 0, commit = 0, durable = 0, fCommit = 0 // fCommit: entries up to here have gone to main
  const acks = [0, 0, 0], healthy = [1, 1, 1] // healthy: the follower's own main answers its pings (M3), from its last ACK
  const entries = new Map() // idx → entry bytes, until committed and handed to main
  const ahead = new Map() // entries that came before an earlier one (around a hand-over)
  const ansQ = [] // { idx, ans: Uint32Array of (seq, status) pairs }, idx rising
  const slotSeq = new Uint32Array(4096)
  const links = [null, null, null]
  let client = null
  const ev = { handovers: 0, no_target: 0, reclaimed: 0, dropped_asks: 0, dropped_results: 0, refused_xfer: 0, watch_trigger_at: null, handed_over_at: null, handed_to: null, became_leader_at: null, rule_timeouts: 0, rule_block_ms: null }
  const corked = new Set()
  const uncorkAll = () => { for (const s of corked) s.uncork(); corked.clear() }
  const send = (s, type, ...bodies) => {
    if (!s) return
    if (!corked.has(s)) { s.cork(); corked.add(s); if (corked.size === 1) setImmediate(uncorkAll) }
    let n = 0; for (const b of bodies) n += b.length
    const h = Buffer.allocUnsafe(5); h.writeUInt32LE(n + 1, 0); h[4] = type
    s.write(h); for (const b of bodies) s.write(b)
  }
  const u32 = (x) => { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(x >>> 0, 0); return b }

  // ── B: the worker's own copy of the rows (committed state), versions, overlay; the session table ──
  const IS_B = FORM === 'B' || FORM === 'Bs' || FORM === 'B2'
  const copy = FORM === 'B' ? new Map() : FORM === 'Bs' ? new K.ShardedMap() : FORM === 'B2' ? new K.CompactRows(Math.ceil(cfg.rows * 1.3), Math.ceil(cfg.rows * (cfg.shape === 'big' ? 2400 : 220) * 1.5) + (64 << 20)) : null
  const verW = FORM === 'B' ? new Map() : FORM === 'Bs' ? new K.ShardedMap() : null // B2 keeps versions in its index
  const ovW = new Map()
  const sessW = new K.Sessions()
  const entryKeys = new Map() // B leader: idx → [keys, slot seqs], to move the overlay into the copy at commit
  const putRow = (k, row, ver) => { if (verW) { copy.set(k, row); verW.set(k, ver) } else copy.set(k, row, ver) }
  const dropRow = (k) => { copy.delete(k); verW?.delete(k) }
  if (copy) K.loadRows(cfg.rows, cfg.shape, (recs) => { for (const r of recs) putRow(r.at, r.value, 0) })
  const workerHeapAfterLoad = heapNow()
  const gcW = process.env.GCSTATS === '1' ? K.gcLog() : null // GC pauses on this thread (opt in: the observer is the only change)
  const applyCopy = (e) => { // B follower: decode the committed entry once more and apply it to the copy
    const n = e.readUInt32LE(8), recs = K.decodeFrame(e.subarray(K.ENTRY_HDR + 8 * n))
    for (let i = 0; i < n; i++) {
      const r = recs[i], k = r.key[0]
      if (r.type === K.REMOVE) dropRow(k)
      else putRow(k, r.key.length === 1 ? r.value : { ...copy.get(k), [r.key[1]]: r.value }, e.readUInt32LE(K.ENTRY_HDR + 4 * n + 4 * i))
      sessW.fresh(e.readUInt32LE(K.ENTRY_HDR + 4 * i))
    }
  }

  // ── +rule, +budget: a user rule on the worker, one vm call a turn (added after review) ──
  // The rule accepts every write; at the stall time one call loops for cfg.stallMs (user code that never
  // yields). With +budget the call has a 10 ms timeout: the write whose rule ran over is refused, the rest run.
  const BUDGET_MS = 10
  const ruleCtx = IS_B && RULE ? vm.createContext({ now: K.now, stallAt: Infinity, stallMs: cfg.stallMs, s0: 0, s1: 0, ws: null, ok: null, i: 0 }) : null
  if (ruleCtx) vm.runInContext('function rule(w) { if (now() >= stallAt) { stallAt = Infinity; s0 = now(); const until = s0 + stallMs; while (now() < until) {} s1 = now() } return typeof w.k === "string" }', ruleCtx)
  const ruleTurn = ruleCtx ? new vm.Script('for (; i < ws.length; i++) ok[i] = rule(ws[i]) ? 1 : 0') : null
  let stallSent = false
  const runRules = (ws) => { // → per write: 1 accepted, 0 refused by the rule, 2 ran over the budget
    ruleCtx.ws = ws; ruleCtx.ok = new Uint8Array(ws.length); ruleCtx.i = 0
    for (;;) {
      try { ruleTurn.runInContext(ruleCtx, RULE === 'budget' ? { timeout: BUDGET_MS } : undefined); break }
      catch (e) {
        if (e.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e
        ev.rule_timeouts++; if (ev.rule_block_ms === null) ev.rule_block_ms = +(K.now() - ruleCtx.s0).toFixed(1)
        ruleCtx.ok[ruleCtx.i] = 2; ruleCtx.i++
      }
    }
    if (ruleCtx.s0 && !stallSent) { stallSent = true; port.postMessage({ t: 'stall', s0: ruleCtx.s0, s1: ruleCtx.s1 || ruleCtx.s0 + cfg.stallMs }) }
    const ok = ruleCtx.ok; ruleCtx.ws = null; ruleCtx.ok = null
    return ok
  }

  // ── M1: writes waiting at main, per partition ──
  const inflight = new Map(), fifo = []

  // ── the log ──
  const journal = new K.Journal(`${cfg.dir}/j.${ID}`, (idx) => { durable = idx; if (isLeader) advance(); else send(links[leaderId], K.T_ACK, u32(term), u32(idx), u32(mainOk() ? 1 : 0)) })
  const append = (frame, aseq, slot, ans, keys) => { // a judged result becomes the next log entry
    let idx = lastIdx
    if (frame) {
      idx = ++lastIdx
      const n = aseq.length, ss = new Uint32Array(n)
      for (let i = 0; i < n; i++) ss[i] = ++slotSeq[slot[i]]
      const e = K.makeEntry(term, idx, aseq, ss, frame)
      entries.set(idx, e)
      if (keys) entryKeys.set(idx, [keys, ss])
      for (const j of OTHERS) send(links[j], K.T_APPEND, u32(term), u32(commit), e)
      journal.push(e, idx)
      bins.appended[binOf(K.now())] += n
    }
    if (ans.length) { if (idx <= commit) answer(ans); else ansQ.push({ idx, ans }) }
  }
  const answer = (ans) => { send(client, K.T_ANS, Buffer.from(ans.buffer, ans.byteOffset, ans.byteLength)); bins.answered[binOf(K.now())] += ans.length / 2 }
  const toMain = (from, to, follower) => { // committed entries (from, to] cross to main for the fold, as one transfer
    let total = 0; for (let i = from + 1; i <= to; i++) total += 4 + entries.get(i).length
    const buf = Buffer.allocUnsafeSlow(total); let off = 0
    for (let i = from + 1; i <= to; i++) {
      const e = entries.get(i); buf.writeUInt32LE(e.length, off); e.copy(buf, off + 4); off += 4 + e.length; entries.delete(i)
      if (copy && follower) applyCopy(e)
    }
    port.postMessage({ t: 'commit', buf: buf.buffer }, [buf.buffer])
    fCommit = to
  }
  const advance = () => { // the leader: commit = the median of the three durable marks
    const a = acks[OTHERS[0]], b = acks[OTHERS[1]], d = durable
    const c = Math.max(Math.min(d, a), Math.min(Math.max(d, a), b))
    if (c > commit) {
      const prev = commit; commit = c
      let n = 0
      for (let i = prev + 1; i <= c; i++) {
        n += entries.get(i).readUInt32LE(8)
        const ek = entryKeys.get(i)
        if (ek) { // B leader: the committed rows move from the overlay into the copy
          const [keys, ss] = ek; entryKeys.delete(i)
          for (let j = 0; j < keys.length; j++) {
            const k = keys[j], o = ovW.get(k)
            if (--o.pend === 0) { if (o.row === null) dropRow(k); else putRow(k, o.row, ss[j]); ovW.delete(k) }
          }
        }
      }
      bins.committed[binOf(K.now())] += n
      while (ansQ.length && ansQ[0].idx <= c) answer(ansQ.shift().ans)
      toMain(prev, c, false)
    }
    if (handing && commit === lastIdx) handOver()
  }

  // ── M3: the watchdog, and the hand-over ──
  let lastPong = 0, hbTimer = null, gaveUp = false
  const mainOk = () => FORM !== 'M3' || K.now() - lastPong <= cfg.watchMs
  const handOver = () => { // to a follower whose main is healthy and that holds every entry; none healthy: stay
    const ok = OTHERS.filter((j) => healthy[j] && acks[j] >= lastIdx)
    if (!ok.length) return // wait for a healthy follower that holds every entry (the watchdog gives up after W)
    const to = ok[0]
    send(links[to], T_XFER, u32(term + 1), u32(lastIdx))
    term++; isLeader = false; handing = false; leaderId = to
    clearInterval(hbTimer)
    send(client, T_MOVED, u32(to))
    port.postMessage({ t: 'stepdown' })
    ev.handed_over_at = K.now(); ev.handed_to = to; ev.handovers++
  }
  const becomeLeader = (t, idx) => {
    learn(idx)
    term = t; isLeader = true; leaderId = ID; commit = fCommit
    acks.fill(0)
    startHB()
    ev.became_leader_at = K.now()
  }

  // ── results of judging, from main (A, M1, M3) ──
  port.on('message', (m) => {
    if (m.t === 'res') {
      if (FORM === 'M1') { for (const k of fifo.shift()) { const c = inflight.get(k) - 1; if (c === 0) inflight.delete(k); else inflight.set(k, c) } }
      if (!isLeader) { ev.dropped_results++; return } // a deposed writer drops its late results; the client resends
      append(m.frame, m.aseq, m.slot, m.ans, null)
    } else if (m.t === 'pong') { lastPong = K.now(); gaveUp = false }
    else if (m.t === 'go') go(m.t0)
    else if (m.t === 'report') report(m.s0, m.s1)
  })

  // ── the client link: ASKs in, answers out ──
  let turn = [] // ASK bodies this event-loop turn
  const flushTurn = () => {
    const asks = turn; turn = []
    if (!isLeader) { ev.dropped_asks += asks.length; return }
    if (FORM === 'A' || FORM === 'M3') { // forward the bytes; main parses and judges
      let total = 0; for (const a of asks) total += 4 + a.length
      const buf = Buffer.allocUnsafeSlow(total); let off = 0
      for (const a of asks) { buf.writeUInt32LE(a.length, off); a.copy(buf, off + 4); off += 4 + a.length }
      port.postMessage({ t: 'ask', buf: buf.buffer }, [buf.buffer])
      return
    }
    const out = { recs: [], aseq: [], slot: [], ans: [] }
    const keys = IS_B ? [] : null
    const flags = FORM === 'M1' ? [] : null, fwdKeys = [] // M1: per write, 0 = main judges it, 1 = the worker appended it (main's overlay takes it), 2 = answered here (a duplicate)
    const parsed = asks.map((a) => JSON.parse(a.toString('utf8')))
    const ruleOk = ruleCtx ? runRules(parsed.length === 1 ? parsed[0] : parsed.flat()) : null
    let wi = 0
    for (const ws of parsed) {
      for (const w of ws) {
        if (ruleOk && ruleOk[wi++] !== 1) { out.ans.push(w.q, K.RULE_TIMEOUT); continue }
        if (FORM === 'none') { out.recs.push(K.plainRec(w)); out.aseq.push(w.q); out.slot.push(K.slotOf(w.k)); out.ans.push(w.q, K.OK); continue }
        if (!sessW.fresh(w.q)) { out.ans.push(w.q, K.DUP); flags?.push(2); continue }
        if (IS_B) { const n0 = out.recs.length; K.judge(w, (k) => copy.get(k), ovW, out); if (out.recs.length > n0) keys.push(w.k); continue }
        // M1: a plain write whose partition has nothing waiting at main is appended here
        if (K.PLAIN(w) && !inflight.has(w.k) && w.k !== '__proto__') {
          out.recs.push(K.plainRec(w)); out.aseq.push(w.q); out.slot.push(K.slotOf(w.k)); out.ans.push(w.q, K.OK); flags.push(1)
        } else { flags.push(0); fwdKeys.push(w.k); inflight.set(w.k, (inflight.get(w.k) ?? 0) + 1) }
      }
    }
    if (out.recs.length || out.ans.length) append(out.recs.length ? K.C.encodeFrame(out.recs) : null, out.aseq, out.slot, Uint32Array.from(out.ans), keys)
    if (flags) { // M1: the same bytes go to main, with the flags, in the same turn: main's overlay sees each direct write before its entry can commit
      const judged = fwdKeys.length > 0
      if (judged) fifo.push(fwdKeys)
      let total = 0; for (const a of asks) total += 4 + a.length
      const buf = Buffer.allocUnsafeSlow(total); let off = 0
      for (const a of asks) { buf.writeUInt32LE(a.length, off); a.copy(buf, off + 4); off += 4 + a.length }
      const fl = Uint8Array.from(flags)
      port.postMessage({ t: 'fwd', buf: buf.buffer, flags: fl.buffer, r: judged }, [buf.buffer, fl.buffer])
    }
  }
  net.createServer((s) => {
    s.setNoDelay(true); s.on('error', () => {})
    client = s
    s.on('data', K.framer((type, body) => { if (type === K.T_ASK) { if (!turn.length) setImmediate(flushTurn); turn.push(Buffer.from(body)) } }))
  }).listen(cfg.clientPorts[ID], '127.0.0.1')

  // ── the links between servers: APPEND, HB, ACK, XFER, each way ──
  const arrivals = [] // absolute ms of every APPEND or HB from a leader
  const learn = (c) => { const to = Math.min(c, lastIdx); if (to > fCommit) toMain(fCommit, to, true) }
  const take = (e) => { // a follower appends an entry in log order
    const idx = e.readUInt32LE(4)
    if (idx <= lastIdx) return
    if (idx !== lastIdx + 1) { ahead.set(idx, e); return }
    lastIdx = idx; entries.set(idx, e); journal.push(e, idx)
    let nx; while ((nx = ahead.get(lastIdx + 1))) { ahead.delete(lastIdx + 1); lastIdx++; entries.set(lastIdx, nx); journal.push(nx, lastIdx) }
  }
  const onPeer = (j, type, body) => {
    if (type === K.T_APPEND || type === K.T_HB) {
      const t = body.readUInt32LE(0), c = body.readUInt32LE(4)
      if (t >= term && j !== ID && !(isLeader && t === term)) { term = t; leaderId = j }
      arrivals.push(K.now())
      if (type === K.T_APPEND) { const e = Buffer.from(body.subarray(8)); if (!K.checkEntry(e)) throw new Error('bad entry crc'); take(e) }
      if (!isLeader) { learn(c); if (type === K.T_HB && FORM === 'M3') send(links[leaderId], K.T_ACK, u32(term), u32(durable), u32(mainOk() ? 1 : 0)) } // M3: a heartbeat's answer carries main's health
    } else if (type === K.T_ACK) {
      const t = body.readUInt32LE(0), a = body.readUInt32LE(4)
      if (isLeader && t === term) { healthy[j] = body.readUInt32LE(8); if (a > acks[j]) acks[j] = a; advance() }
    } else if (type === T_XFER) {
      // a server whose own main thread is stalled must not take a leadership (M3's second rule)
      if (!mainOk()) { ev.refused_xfer++; send(links[j], T_XFER_NO, u32(body.readUInt32LE(0))); return }
      becomeLeader(body.readUInt32LE(0), body.readUInt32LE(4))
    } else if (type === T_XFER_NO) { // the target refused: lead again, as A would
      if (!isLeader && leaderId === j) { becomeLeader(term + 1, fCommit); send(client, T_MOVED, u32(ID)); ev.reclaimed++ }
    }
  }
  const attach = (j, s) => { links[j] = s; s.on('data', K.framer((type, body) => onPeer(j, type, body))) }
  net.createServer((s) => {
    s.setNoDelay(true); s.on('error', () => {})
    const hello = K.framer((type, body) => { if (type === T_HELLO) { s.removeListener('data', hello); attach(body.readUInt32LE(0), s) } })
    s.on('data', hello)
  }).listen(cfg.peerPorts[ID], '127.0.0.1', () => port.postMessage({ t: 'ready', workerHeapAfterLoad }))

  // ── heartbeats, the run's clock ──
  const hbGaps = [] // [absolute ms, gap ms] of the heartbeat timer, as this thread sees it
  const startHB = () => {
    let last = performance.now()
    hbTimer = setInterval(() => { const tt = performance.now(); hbGaps.push([K.now(), tt - last]); last = tt; for (const j of OTHERS) send(links[j], K.T_HB, u32(term), u32(commit)) }, cfg.hbMs)
  }
  let eldW = null, elu0W = null, eluW = null // ELU: the share of the steady window this thread was busy (added after review)
  const go = async (t) => {
    t0 = t
    const at = (ms, fn) => setTimeout(fn, Math.max(0, t0 + ms - K.now()))
    at(cfg.phases.warm, () => { eldW = monitorEventLoopDelay({ resolution: 1 }); eldW.enable(); elu0W = performance.eventLoopUtilization() })
    at(cfg.phases.warm + cfg.phases.steady, () => { eldW.disable(); eluW = +performance.eventLoopUtilization(elu0W).utilization.toFixed(3) })
    if (ruleCtx && FIRST_LEADER) ruleCtx.stallAt = t0 + cfg.phases.warm + cfg.phases.steady
    for (const j of OTHERS.filter((x) => x > ID)) {
      const s = await new Promise((res) => { const tryOnce = () => { const x = net.connect(cfg.peerPorts[j], '127.0.0.1'); x.once('connect', () => { x.setNoDelay(true); res(x) }); x.once('error', () => setTimeout(tryOnce, 20)) }; tryOnce() })
      s.on('error', () => {}); s.write(Buffer.concat(K.msg(T_HELLO, u32(ID)))); attach(j, s)
    }
    if (isLeader) startHB()
    if (FORM === 'M3') {
      lastPong = K.now()
      setInterval(() => { // every server pings its own main; a leader whose main is silent hands over
        port.postMessage({ t: 'ping' })
        if (isLeader && !handing && !gaveUp && K.now() - lastPong > cfg.watchMs) { handing = true; ev.watch_trigger_at = K.now() }
        if (handing && K.now() - ev.watch_trigger_at > cfg.watchMs) { handing = false; gaveUp = true; ev.no_target++ } // no healthy follower in time: lead on, as A, until main answers again
        if (handing) advance()
      }, 20)
    }
  }
  const report = (s0, s1) => {
    port.postMessage({ t: 'report', w: {
      gc: gcW ? { steady: gcW.summary(t0 + cfg.phases.warm, t0 + cfg.phases.warm + cfg.phases.steady), stall: gcW.summary(s0, s1 + 200), all: gcW.summary(t0, Infinity) } : null,
      copyBytes: FORM === 'B2' ? copy.bytes() : null,
      lastIdx, commit, term, isLeader, flushes: journal.flushes, eld: eldW ? K.eldSummary(eldW) : null, elu: eluW, hbGaps, arrivals, ev,
      bins: { appended: Array.from(bins.appended), committed: Array.from(bins.committed), answered: Array.from(bins.answered) },
      workerHeapEnd: heapNow(), copyRows: copy ? copy.size : null, copyDigest: copy ? K.digest((f) => copy.forEach((r, k) => f(k, r))) : null, overlayEnd: ovW.size,
    } })
    journal.close()
  }
} else {
// ═════════════════════════════════════════ main thread ═════════════════════════════════════════
  const p = K.S.proxy({})
  let rejects = 0, rejectMsg = null
  const lane = K.D.lane(p, { origin: K.S.ORIGIN, onReject: (rj) => { rejects++; rejectMsg ??= String(rj.error?.message ?? rj.error) } })
  const node = p[K.D.node]
  const readRow = (k) => node.get(k)
  const verMap = new Map() // the row version beside data's rows (E-56's `ver`)
  const ov = new Map() // the overlay on main (A, M1, M3)
  const sess = new K.Sessions() // the session table: from committed entries, and from writes judged here
  const gcM = process.env.GCSTATS === '1' ? K.gcLog() : null
  const w = new Worker(new URL(import.meta.url), { workerData: { cfg } })
  const workerReady = new Promise((res) => w.once('message', (m) => res(m)))
  const tl0 = performance.now()
  K.loadRows(cfg.rows, cfg.shape, (recs) => { lane(recs); for (const r of recs) verMap.set(r.at, 0) })
  const loadS = +((performance.now() - tl0) / 1000).toFixed(2)
  const mainHeapAfterLoad = heapNow()
  const wr = await workerReady
  const rssAfterLoad = K.mb(process.memoryUsage().rss)

  let judged = 0, folded = 0, t0 = 0
  const fold = (ab) => {
    const buf = Buffer.from(ab); let off = 0
    while (off < buf.length) {
      const len = buf.readUInt32LE(off), e = buf.subarray(off + 4, off + 4 + len); off += 4 + len
      const n = e.readUInt32LE(8), recs = K.decodeFrame(e.subarray(K.ENTRY_HDR + 8 * n))
      lane(recs)
      for (let i = 0; i < n; i++) {
        const r = recs[i], k = r.key[0]
        if (r.type === K.REMOVE) verMap.delete(k); else verMap.set(k, e.readUInt32LE(K.ENTRY_HDR + 4 * n + 4 * i))
        const o = ov.get(k); if (o !== undefined && --o.pend === 0) ov.delete(k)
        sess.fresh(e.readUInt32LE(K.ENTRY_HDR + 4 * i))
      }
      folded += n
    }
  }
  const post = (out) => {
    judged += out.ans.length / 2
    w.postMessage({ t: 'res', frame: out.recs.length ? K.C.encodeFrame(out.recs) : null, aseq: Uint32Array.from(out.aseq), slot: Uint16Array.from(out.slot), ans: Uint32Array.from(out.ans) })
  }
  w.on('message', (m) => {
    if (m.t === 'commit') fold(m.buf)
    else if (m.t === 'ask') { // A, M3: parse and judge on data's rows
      const buf = Buffer.from(m.buf), out = { recs: [], aseq: [], slot: [], ans: [] }; let off = 0
      while (off < buf.length) {
        const len = buf.readUInt32LE(off), ws = JSON.parse(buf.toString('utf8', off + 4, off + 4 + len)); off += 4 + len
        for (const x of ws) { if (!sess.fresh(x.q)) { out.ans.push(x.q, K.DUP); continue } K.judge(x, readRow, ov, out) }
      }
      post(out)
    } else if (m.t === 'fwd') { // M1: the turn's writes, in arrival order: judge some, take the worker's own appends into the overlay
      const buf = Buffer.from(m.buf), flags = new Uint8Array(m.flags), out = { recs: [], aseq: [], slot: [], ans: [] }; let off = 0, i = 0
      while (off < buf.length) {
        const len = buf.readUInt32LE(off), ws = JSON.parse(buf.toString('utf8', off + 4, off + 4 + len)); off += 4 + len
        for (const x of ws) {
          const f = flags[i++]
          if (f === 0) K.judge(x, readRow, ov, out)
          else if (f === 1) { const row = x.o === 'r' ? null : x.v, o = ov.get(x.k); if (o !== undefined) { o.row = row; o.pend++ } else ov.set(x.k, { row, pend: 1 }) }
        }
      }
      if (m.r) post(out)
    } else if (m.t === 'stall') console.log(JSON.stringify({ stall: { s0: m.s0, s1: m.s1 } })) // +rule, +budget: the stall was in the worker's rule
    else if (m.t === 'ping') w.postMessage({ t: 'pong' })
    else if (m.t === 'stepdown') ov.clear() // M3: the judged tail that never reached the log is dropped
  })

  console.log(JSON.stringify({ ready: ID }))
  let s0 = null, s1 = null, eldM = null, cpu0 = null, cores = null, elu0M = null, eluM = null // cores: the process's CPU (all threads) over the steady window
  const done = new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const [cmd, a, b] = line.trim().split(' ')
      if (cmd === 'go') {
        t0 = +a; w.postMessage({ t: 'go', t0 })
        const P = cfg.phases, at = (ms, fn) => setTimeout(fn, Math.max(0, t0 + ms - K.now()))
        at(P.warm, () => { eldM = monitorEventLoopDelay({ resolution: 1 }); eldM.enable(); cpu0 = process.cpuUsage(); elu0M = performance.eventLoopUtilization() })
        at(P.warm + P.steady, () => { eldM.disable(); const c = process.cpuUsage(cpu0); cores = +((c.user + c.system) / 1e3 / P.steady).toFixed(3); eluM = +performance.eventLoopUtilization(elu0M).utilization.toFixed(3) })
        if (FIRST_LEADER && !RULE) at(P.warm + P.steady, () => {
          s0 = K.now(); const until = performance.now() + cfg.stallMs; while (performance.now() < until) { /* user code that never yields */ } s1 = K.now()
          console.log(JSON.stringify({ stall: { s0, s1 } }))
        })
      } else if (cmd === 'phases') resolve([+a, +b])
    })
  })
  const ph = await done // every server waits for the driver's 'phases', sent once the client has every answer
  s0 = ph[0]; s1 = ph[1]
  const wrep = await new Promise((res) => { w.on('message', (m) => { if (m.t === 'report') res(m.w) }); w.postMessage({ t: 'report', s0, s1 }) })
  const phase = (t) => (t < t0 + cfg.phases.warm ? 'warm' : t < s0 ? 'steady' : t < s1 + 200 ? 'stall' : 'after')
  const split = (pairs) => { const o = { steady: [], stall: [], after: [] }; for (const [t, v] of pairs) { const x = phase(t); if (o[x]) o[x].push(v) } return { steady: K.st(o.steady), stall: K.st(o.stall), after: K.st(o.after) } }
  const gapPairs = []; for (let i = 1; i < wrep.arrivals.length; i++) gapPairs.push([wrep.arrivals[i], wrep.arrivals[i] - wrep.arrivals[i - 1]])
  const rel = (t) => (t === null ? null : +(t - s0).toFixed(1))
  console.log(JSON.stringify({
    exp: 'E-63', id: ID, first_leader: FIRST_LEADER, form: cfg.form, rows: cfg.rows, shape: cfg.shape, node: process.version,
    execArgv: process.execArgv.filter((x) => !/strip-types|warnings|expose-gc/.test(x)),
    t0, s0, s1, stall_ms: s0 && s1 ? +(s1 - s0).toFixed(0) : null, load_s: loadS,
    mem_after_load: { main_heap_mb: mainHeapAfterLoad, worker_heap_mb: wr.workerHeapAfterLoad, rss_mb: rssAfterLoad },
    mem_end: { main_heap_mb: heapNow(), worker_heap_mb: wrep.workerHeapEnd, rss_mb: K.mb(process.memoryUsage().rss), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) },
    digest: K.digest((f) => node.each(f)), rows_end: node.rowCount(), judged_on_main: judged, folded, fold_rejects: rejects, fold_reject_first: rejectMsg, overlay_end: ov.size,
    eld_main_steady: eldM ? K.eldSummary(eldM) : null, eld_worker_steady: wrep.eld, cores_steady: cores, elu_main_steady: eluM, elu_worker_steady: wrep.elu,
    gc_main: gcM ? { steady: gcM.summary(t0 + cfg.phases.warm, t0 + cfg.phases.warm + cfg.phases.steady), stall: gcM.summary(s0, s1 + 200), all: gcM.summary(t0, Infinity) } : undefined, gc_worker: wrep.gc ?? undefined, copy_bytes: wrep.copyBytes ?? undefined,
    hb_timer_gap: split(wrep.hbGaps), leader_msg_gap: split(gapPairs),
    events_ms_after_s0: { watch_trigger: rel(wrep.ev.watch_trigger_at), handed_over: rel(wrep.ev.handed_over_at), became_leader: rel(wrep.ev.became_leader_at) },
    events: { handovers: wrep.ev.handovers, no_target: wrep.ev.no_target, reclaimed: wrep.ev.reclaimed, handed_to: wrep.ev.handed_to, dropped_asks: wrep.ev.dropped_asks, dropped_results: wrep.ev.dropped_results, refused_xfer: wrep.ev.refused_xfer, rule_timeouts: wrep.ev.rule_timeouts, rule_block_ms: wrep.ev.rule_block_ms },
    log: { last: wrep.lastIdx, commit: wrep.commit, term: wrep.term, leader_at_end: wrep.isLeader, flushes: wrep.flushes, copy_rows: wrep.copyRows, copy_digest: wrep.copyDigest, overlay_worker_end: wrep.overlayEnd },
    bins: wrep.bins,
  }))
  process.exit(0)
}
