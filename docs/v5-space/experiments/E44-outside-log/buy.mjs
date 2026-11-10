// E-44: the BUY row. fero's patterns P-01 (live shared state), P-14 (invariants), P-10 (locks) and P-09 (work
// queue) on an outside log: NATS JetStream 2.10.22, with `data` folding the stream on every client.
// JetStream gives: a replicated, ordered log per stream; a check-and-write per subject (publish only if the
// subject's last message has sequence n); a dedup window by message id; message expiry by age; work-queue
// retention with leases (ack wait) and a delivery limit. Everything else is here.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
const NPM = process.env.E44_NPM, DATA = process.env.E44_DATA
const { connect, headers, nanos, AckPolicy, RetentionPolicy, StorageType, DiscardPolicy } = createRequire(pathToFileURL(NPM + '/'))('nats')
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)

const ONE_ID = process.env.E44_ONE_ID === '1'   // for checks.mjs burn only: the prototype's first form, one message id for every try of an attempt
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (k) => { if (k === '') throw new Error('empty key'); return Buffer.from(String(k), 'utf8').toString('base64url') } // any key as one subject token
const dec = (t) => Buffer.from(t, 'base64url').toString('utf8')
const conflict = (e) => e?.api_error?.err_code === 10071 || /wrong last sequence/.test(String(e?.message))
const transient = (e) => ['TIMEOUT', '503', 'CONNECTION_CLOSED', 'DISCONNECT'].includes(e?.code) || /timeout|no response|unavailable|leader/i.test(String(e?.message))
export const refuse = (why) => ({ refused: why })

export async function open(servers, name = 'buy') {
  const nc = await connect({ servers, name, maxReconnectAttempts: -1, reconnectTimeWait: 50 })
  return { nc, js: nc.jetstream({ timeout: 2000 }), jsm: await nc.jetstreamManager({ timeout: 2000 }) }
}
// any call that may meet a leader change: try again while the error is of the passing kind
const retry = async (fn, tries = 60) => { for (let t = 0; ; t++) { try { return await fn() } catch (e) { if (!transient(e) || t >= tries) throw e; await sleep(50 + 10 * t) } } }
const ensure = async (ctx, cfg) => { for (let t = 0; ; t++) { try { await ctx.jsm.streams.info(cfg.name); return } catch (e) { try { await ctx.jsm.streams.add({ storage: StorageType.File, num_replicas: 3, allow_direct: true, ...cfg }); return } catch (e2) { if (t > 30) throw e2; await sleep(100) } } } }
// publish, retrying a lost answer with the SAME message id: inside the dedup window the retry cannot land twice
const publish = async (ctx, subject, body, opts) => {
  for (let t = 0; ; t++) {
    try { return await ctx.js.publish(subject, body, opts) } catch (e) { if (conflict(e) || !transient(e) || t >= 40) throw e; await sleep(50 + 10 * t) }
  }
}
const latest = async (ctx, stream, subject) => {
  for (let t = 0; ; t++) {
    try { const m = await ctx.jsm.streams.getMessage(stream, { last_by_subj: subject }); const del = m.header?.get('Fero-Op') === 'del'
      return { version: m.seq, value: del ? undefined : JSON.parse(new TextDecoder().decode(m.data)), fence: Number(m.header?.get('Fero-Fence') ?? 0), attempt: m.header?.get('Fero-Attempt') ?? '' }
    } catch (e) { if (e?.api_error?.err_code === 10037 || /no message found/.test(String(e?.message))) return { version: 0, value: undefined, fence: 0, attempt: '' }; if (!transient(e) || t >= 40) throw e; await sleep(50) }
  }
}

// ── P-01 and P-14: a resource is a stream that keeps the last message per row; every client folds it with data ──
export async function fero(ctx, name, opts = {}) {
  const stream = 'FERO_' + name, prefix = 'fero.' + name + '.'
  await ensure(ctx, { name: stream, subjects: [prefix + '>'], max_msgs_per_subject: 1, duplicate_window: nanos(opts.dedupMs ?? 120000) })
  const src = D.$({}), fold = D.lane(src, {})
  let applied = 0, waiters = [], isReady, closed = false
  const ready = new Promise((r) => (isReady = r))
  const consumer = await ctx.js.consumers.get(stream)                       // an ordered consumer: the whole stream, in order, from the start
  const sub = await consumer.consume()
  ;(async () => {
    for await (const m of sub) {
      const key = dec(m.subject.slice(prefix.length))
      fold([m.headers?.get('Fero-Op') === 'del' ? { type: 2, key: [key] } : { type: 0, key: [key], value: JSON.parse(m.string()) }])
      applied = m.seq
      if (waiters.length) { const w = waiters; waiters = []; for (const x of w) x.seq <= applied ? x.go() : waiters.push(x) }
      if (m.info.pending === 0) isReady()
    }
  })().catch((e) => { if (!closed) console.error('fold stopped:', e.message) })
  if ((await ctx.jsm.streams.info(stream)).state.messages === 0) isReady()
  await ready
  const seen = (seq) => (seq <= applied ? null : new Promise((go) => waiters.push({ seq, go })))   // read your writes: wait for the own fold
  const write = async (key, row, o = {}, op = 'set') => {
    const attempt = o.attempt ?? randomUUID()
    const h = headers(); h.set('Fero-Attempt', attempt); if (op === 'del') h.set('Fero-Op', 'del'); if (o.fence !== undefined) h.set('Fero-Fence', String(o.fence))
    // the message id names one try, not the attempt: a clustered stream remembers the id of a publish it refused
    // for a wrong sequence (msgid_probe.mjs), so a second try under the same id is dropped as a duplicate
    const p = { msgID: o.version === undefined || ONE_ID ? attempt : attempt + ':' + o.version, headers: h }
    if (o.version !== undefined) p.expect = { lastSubjectSequence: o.version }
    try { const ack = await publish(ctx, prefix + enc(key), op === 'del' ? '' : JSON.stringify(row), p); if (!o.nowait) await seen(ack.seq); return { ok: true, version: ack.seq, duplicate: ack.duplicate } }
    catch (e) { if (conflict(e)) return { ok: false, why: 'version' }; throw e }
  }
  // check, then write only if the row did not change: the one loop every conditional op is built from
  const update = async (key, fn, o = {}) => {
    const attempt = o.attempt ?? randomUUID()
    for (let retries = 0; ; retries++) {
      const cur = await latest(ctx, stream, prefix + enc(key))
      if (cur.attempt === attempt) { await seen(cur.version); return { ok: true, version: cur.version, value: cur.value, retries } }   // the first try landed; its answer was lost
      if (o.fence !== undefined && cur.fence > o.fence) return { ok: false, why: 'fenced', retries }
      const next = fn(cur.value)
      if (next && next.refused) return { ok: false, why: next.refused, retries }
      const r = await write(key, next, { version: cur.version, attempt, fence: o.fence !== undefined ? Math.max(o.fence, cur.fence) : cur.fence || undefined })
      if (r.ok) return { ...r, value: next, retries }
    }
  }
  return {
    name, data: src, get snapshot() { return src[D.value] }, get applied() { return applied },
    set: (key, row, o = {}) => (o.if?.fence !== undefined ? update(key, () => row, { fence: o.if.fence, attempt: o.attempt }) : write(key, row, { version: o.if?.version, attempt: o.attempt, nowait: o.nowait })),   // nowait: answer at the ack, do not wait for the own fold
    remove: (key, o = {}) => write(key, null, { version: o.if?.version, attempt: o.attempt }, 'del'),
    get: (key) => latest(ctx, stream, prefix + enc(key)),                    // a fresh read: one round trip to the stream
    update,
    incr: (key, field, n, { min = -Infinity, max = Infinity } = {}, o) => update(key, (row) => { const v = (row?.[field] ?? 0) + n; return v < min || v > max ? refuse('bounds') : { ...row, [field]: v } }, o),
    close: () => { closed = true; sub.stop() },
  }
}

// ── P-10: a lock is the one message on its subject; it dies of age unless its holder rewrites it in time ──
export async function lock(ctx, name, { leaseMs = 10000, waitMs = 0 } = {}) {
  const stream = 'LOCK_' + leaseMs, subject = 'lock.' + leaseMs + '.' + enc(name), id = randomUUID()
  await ensure(ctx, { name: stream, subjects: ['lock.' + leaseMs + '.>'], max_msgs_per_subject: 1, max_age: nanos(leaseMs), duplicate_window: nanos(Math.min(leaseMs, 120000)) })
  const deadline = Date.now() + waitMs
  let rev
  for (let n = 0; ; n++) {
    try { rev = (await publish(ctx, subject, id, { msgID: id + ':' + n, expect: { lastSubjectSequence: 0 } })).seq; break }   // only if the subject is empty
    catch (e) { if (!conflict(e)) throw e; if (Date.now() >= deadline) return { ok: false, why: 'locked' }; await sleep(Math.min(25, leaseMs / 10)) }
  }
  const fence = rev                                                         // the stream's sequence: it only ever rises
  let held = true, lostGo, last = Date.now(), n = 0
  const lost = new Promise((r) => (lostGo = r))
  const renew = async () => {
    if (!held) return
    try { rev = (await ctx.js.publish(subject, id, { msgID: id + ':r' + ++n, expect: { lastSubjectSequence: rev }, timeout: leaseMs / 3 })).seq; last = Date.now() }
    catch (e) { if (conflict(e) || Date.now() - last > leaseMs) { held = false; clearInterval(timer); lostGo(conflict(e) ? 'taken' : 'expired') } }
  }
  const timer = setInterval(renew, leaseMs / 3)
  return { ok: true, fence, lost, get held() { return held }, pause: () => clearInterval(timer),               // pause: for the tests, a holder that stops (a long GC, a SIGSTOP)
    release: async () => { held = false; clearInterval(timer); try { await ctx.jsm.streams.deleteMessage(stream, rev, false) } catch {} } }
}

// ── P-09: a work queue is a stream that drops a message when it is acked; a lease is the consumer's ack wait ──
export async function queue(ctx, name, { leaseMs = 30000, deliveries = 5, strict = false, dedupMs = 120000 } = {}) {
  const stream = 'Q_' + name, dead = 'Q_' + name + '_dead', prefix = 'q.' + name + '.'
  await ensure(ctx, { name: stream, subjects: [prefix + '>'], retention: RetentionPolicy.Workqueue, duplicate_window: nanos(dedupMs) })
  await ensure(ctx, { name: dead, subjects: ['qdead.' + name + '.>'], duplicate_window: nanos(dedupMs) })
  const ccfg = { ack_policy: AckPolicy.Explicit, ack_wait: nanos(leaseMs), max_deliver: deliveries }
  const consumers = new Map()
  // strict = one message of a partition in flight at a time (SQS FIFO's rule): JetStream can only say that per
  // consumer, so each partition gets its own consumer; otherwise one consumer serves every partition
  const consumerFor = async (partition) => {
    const cname = strict ? 'p_' + enc(partition) : 'w'
    if (!consumers.has(cname)) {
      const cfg = strict ? { ...ccfg, durable_name: cname, filter_subject: prefix + enc(partition), max_ack_pending: 1 } : { ...ccfg, durable_name: cname }
      try { await ctx.jsm.consumers.add(stream, cfg) } catch (e) { if (!/already/.test(e.message)) throw e }
      consumers.set(cname, await ctx.js.consumers.get(stream, cname))
    }
    return consumers.get(cname)
  }
  if (!strict) await consumerFor('main')
  const wrap = (m) => ({ job: JSON.parse(m.string()), seq: m.seq, deliveries: m.info.redeliveryCount, partition: dec(m.subject.slice(prefix.length)), ack: () => m.ackAck().catch(() => false), nack: (ms) => m.nak(ms) })
  const take = async (n = 1, waitMs = 1000) => {
    const out = []
    if (!strict) {
      // hand over what is there: once a message has come, stop waiting when 30 ms pass with no other (a message
      // held back while the batch fills would sit inside its lease, unseen)
      try {
        const it = await consumers.get('w').fetch({ max_messages: n, expires: Math.max(1000, waitMs) }); let idle = null
        for await (const m of it) { out.push(wrap(m)); if (out.length >= n) break; clearTimeout(idle); idle = setTimeout(() => it.stop(), 30) }
        clearTimeout(idle)
      } catch (e) { if (!transient(e)) throw e }                            // a leader change: this take comes back empty
      return out
    }
    // strict: ask each partition's consumer in turn, without waiting ("no message" is an answer); go round until
    // something comes or the wait is over. One request per partition per round.
    for (const until = Date.now() + waitMs; ; ) {
      for (const [cname] of consumers) {
        if (out.length >= n) break
        try { out.push(wrap(await ctx.js.pull(stream, cname, 0))) } catch (e) { if (!(['404', '408', '409'].includes(e.code) || transient(e))) throw e }   // 404: nothing to hand out; 408, 409: the partition is busy
      }
      if (out.length || Date.now() >= until) return out
      await sleep(15)
    }
  }
  // the dead-letter move: JetStream stops handing out a message after `deliveries` tries, leaves it in the
  // stream, and says so once on a plain (not stored) subject. Copy it to the dead stream, then delete it.
  const move = async (seq) => {
    let m; try { m = await ctx.jsm.streams.getMessage(stream, { seq }) } catch { return false }
    await publish(ctx, 'qdead.' + name + '.' + m.subject.slice(prefix.length), m.data, { msgID: 'dead:' + seq })
    try { await ctx.jsm.streams.deleteMessage(stream, seq, false) } catch {}
    return true
  }
  let reaper = null
  const reap = () => { reaper = ctx.nc.subscribe('$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.' + stream + '.>', { callback: (err, msg) => { if (!err) move(JSON.parse(new TextDecoder().decode(msg.data)).stream_seq).catch(() => {}) } }); return reaper }
  // a missed advisory leaves the message in the stream for good: when nothing is in flight, whatever is still in the
  // stream at or below the last handed-out sequence was given up on
  const sweep = async () => {
    let moved = 0
    for (const c of await ctx.jsm.consumers.list(stream).next()) {
      if (c.num_ack_pending !== 0) continue
      const st = (await ctx.jsm.streams.info(stream)).state
      for (let seq = st.first_seq; seq <= Math.min(st.last_seq, c.delivered.stream_seq); seq++) { try { const m = await ctx.jsm.streams.getMessage(stream, { seq }); if (!c.config.filter_subject || c.config.filter_subject === m.subject) if (await move(seq)) moved++ } catch {} }
    }
    return moved
  }
  return {
    name, take, reap, sweep,
    add: async (job, { id = randomUUID(), partition = 'main' } = {}) => { if (strict) await consumerFor(partition); const a = await publish(ctx, prefix + enc(partition), JSON.stringify(job), { msgID: id }); return { seq: a.seq, duplicate: a.duplicate } },
    depth: async () => (await retry(() => ctx.jsm.streams.info(stream))).state.messages,
    deadCount: async () => (await retry(() => ctx.jsm.streams.info(dead))).state.messages,
    state: async () => (await retry(() => ctx.jsm.streams.info(stream))).state,
    stop: () => reaper?.unsubscribe(),
  }
}
