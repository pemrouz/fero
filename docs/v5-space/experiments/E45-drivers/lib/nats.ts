// nats — a NATS client-protocol front over fero, so `nats bench`, `nats latency` and any NATS
// client can drive fero (PERF-03; PERF-04 through the JetStream subset in jetstream.ts). L5: built
// only from fero() and the verbs.
//
// Core NATS (P-06, P-21):
//   PUB subj [reply] n / HPUB subj [reply] hn tn → set(subj, { d, r?, h? }) on the resource `nats`
//       (rows: false; durability 'none' by default, as PERF-03 asks; --durability persisted beside it).
//       The subject is the partition. Payload and headers travel as latin1 strings (F3: the API has
//       no byte values). A PUB is not answered (core NATS has no ack), so the gateway sends the
//       set() and moves on; per-connection order per subject is kept by a chain (F4).
//   SUB subj [queue] sid → read({ partitions: [subj], from: 'latest' }); a wildcard subject reads
//       by prefix (`a.b.>` → prefix 'a.b.') or the whole log, filtered by NATS's own match rule.
//       A queue group shares one reader per (subject, queue) on this gateway and deals each message
//       to one member in turn (across gateways it would need `read({ share })` or claims: F5).
//   UNSUB sid [max], PING/PONG, CONNECT, and no-responders: a request (PUB with a reply) to a
//       subject no subscription on this gateway matches gets the 503 status at once, as NATS does.
// JetStream: `$JS.API.>` requests and publishes to a stream's subjects go to jetstream.ts.

import net from 'node:net'
import { type GatewayEnv, KeyChains, codeOf } from './common.ts'
import { JetStream } from './jetstream.ts'

export const resources = (o: Record<string, string>): [string, Record<string, unknown>][] =>
  [[o.resource ?? 'nats', o.durability === 'persisted' ? { rows: false } : { rows: false, durability: 'none' }]]

/** NATS subject match: `*` one token, `>` the rest */
export const matches = (pattern: string, subject: string): boolean => {
  if (pattern === subject) return true
  const p = pattern.split('.'), s = subject.split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i
    if (i >= s.length) return false
    if (p[i] !== '*' && p[i] !== s[i]) return false
  }
  return p.length === s.length
}
const wild = (subj: string): boolean => subj.split('.').some((t) => t === '*' || t === '>')
/** the longest literal prefix of a wildcard subject, ending in a dot */
const litPrefix = (subj: string): string => {
  const t = subj.split('.')
  const i = t.findIndex((x) => x === '*' || x === '>')
  return i <= 0 ? '' : t.slice(0, i).join('.') + '.'
}

export interface Msg { subject: string; reply?: string; h?: string; d: string }

/** one client connection's view of the protocol, shared with jetstream.ts */
export interface Conn {
  id: number
  deliver(sid: string, m: Msg): void
  /** a message the gateway makes for this connection's subscriptions that match `inbox`
   *  (JetStream API answers, pulled messages, no-responders); m.subject is kept as given */
  toInbox(inbox: string, m: Msg): number
  /** a request answered by the gateway itself */
  respond(reply: string, d: string, h?: string): void
}

interface Sub { sid: string; subject: string; queue?: string; max: number; got: number; stop(): void }

export const start = async (env: GatewayEnv): Promise<{ close(): Promise<void>; port: number }> => {
  const name = env.opts.resource ?? 'nats'
  const bus = await env.fero(name)
  const { stats } = env
  const subs = new Map<Conn, Map<string, Sub>>()           // every live subscription on this gateway
  const queues = new Map<string, { members: { c: Conn; s: Sub }[]; next: number; stop(): void }>()
  const js = new JetStream(env)
  const debug = !!process.env.E45_DEBUG

  /** does any subscription on this gateway match `subject`? (no-responders) */
  const anyone = (subject: string): boolean => {
    for (const m of subs.values()) for (const s of m.values()) if (matches(s.subject, subject)) return true
    return false
  }

  /** a fero reader for a NATS subject, pumped into `on`; returns its stop */
  const pump = (subject: string, on: (m: Msg) => void): (() => void) => {
    const r = env.run(() => wild(subject)
      ? (litPrefix(subject) ? bus.read({ from: 'latest', prefix: litPrefix(subject) }) : bus.read({ from: 'latest' }))
      : bus.read({ from: 'latest', partitions: [subject] }))
    let live = true
    void (async () => {
      try {
        for await (const e of r) {
          if (!live) break
          const subj = String(e.partition)
          if (!matches(subject, subj)) continue
          const v = e.rec.value as { d: string; r?: string; h?: string }
          on({ subject: subj, reply: v.r, h: v.h, d: v.d })
        }
      } catch (err) { stats.err('read-' + codeOf(err)) }
    })()
    return () => { live = false; r.close() }
  }

  const server = net.createServer((sock) => {
    stats.conns++
    sock.setNoDelay(true)
    // payloads are latin1 strings (one char per byte): write them as latin1, never as utf8
    const out = (s: string | Buffer): void => { const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s; stats.bytesOut += b.length; sock.write(b) }
    const conn: Conn = {
      id: stats.conns,
      deliver: (sid, m) => {
        const sub = mine.get(sid)
        if (sub) { sub.got++; if (sub.max > 0 && sub.got >= sub.max) unsub(sid) }
        stats.op('deliver')
        const rp = m.reply ? ' ' + m.reply : ''
        if (m.h !== undefined) out(`HMSG ${m.subject} ${sid}${rp} ${m.h.length} ${m.h.length + m.d.length}\r\n` + m.h + m.d + '\r\n')
        else out(`MSG ${m.subject} ${sid}${rp} ${m.d.length}\r\n` + m.d + '\r\n')
      },
      toInbox: (inbox, m) => { let n = 0; for (const s of [...mine.values()]) if (matches(s.subject, inbox)) { conn.deliver(s.sid, m); n++ } return n },
      respond: (reply, d, h) => { conn.toInbox(reply, { subject: reply, d, h }) },
    }
    const mine = new Map<string, Sub>()
    subs.set(conn, mine)
    const chains = new KeyChains()
    const unsub = (sid: string): void => {
      const s = mine.get(sid)
      if (!s) return
      mine.delete(sid)
      s.stop()
    }
    const sub = (subject: string, queue: string | undefined, sid: string): void => {
      stats.op('SUB')
      const s: Sub = { sid, subject, queue, max: 0, got: 0, stop: () => {} }
      mine.set(sid, s)
      if (!queue) { s.stop = pump(subject, (m) => conn.deliver(sid, m)); return }
      const qk = subject + '\u0000' + queue
      let q = queues.get(qk)
      if (!q) {
        const qq = { members: [] as { c: Conn; s: Sub }[], next: 0, stop: () => {} }
        qq.stop = pump(subject, (m) => {
          if (qq.members.length === 0) return
          const t = qq.members[qq.next++ % qq.members.length]
          t.c.deliver(t.s.sid, m)
        })
        queues.set(qk, qq)
        q = qq
      }
      const qref = q
      qref.members.push({ c: conn, s })
      s.stop = () => {
        qref.members = qref.members.filter((x) => x.s !== s)
        if (qref.members.length === 0) { qref.stop(); queues.delete(qk) }
      }
    }
    const pub = (subject: string, reply: string | undefined, h: string | undefined, d: string): void => {
      stats.op(h === undefined ? 'PUB' : 'HPUB')
      if (js.owns(subject)) { js.publish(conn, subject, reply, h, d); return }
      if (reply && !anyone(subject)) {
        // no-responders (NATS 2.2+): a request nobody can answer gets a 503 at once
        stats.op('no-responders')
        conn.respond(reply, '', 'NATS/1.0 503\r\n\r\n')
        return
      }
      const v: Record<string, string> = { d }
      if (reply) v.r = reply
      if (h !== undefined) v.h = h
      chains.run(subject, () => env.run(() => bus.set(subject, v))).catch((e: unknown) => stats.err('pub-' + codeOf(e)))
    }
    out(`INFO ${JSON.stringify({
      server_id: 'FERO-E45-GATEWAY', server_name: 'fero-e45', version: '2.10.22', proto: 1, go: 'node',
      host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, headers: true, max_payload: 1048576,
      jetstream: true, client_id: conn.id,
    })}\r\n`)

    let buf: Buffer = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      stats.bytesIn += chunk.length
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      let i = 0
      for (;;) {
        const e = buf.indexOf('\r\n', i, 'latin1')
        if (e < 0) break
        const line = buf.toString('latin1', i, e)
        const sp = line.indexOf(' ')
        const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase()
        const rest = sp < 0 ? '' : line.slice(sp + 1)
        if (verb === 'PUB' || verb === 'HPUB') {
          const a = rest.trim().split(/\s+/)
          const total = Number(a[a.length - 1])
          if (e + 2 + total + 2 > buf.length) break   // wait for the payload
          const body = buf.toString('latin1', e + 2, e + 2 + total)
          i = e + 2 + total + 2
          if (verb === 'PUB') pub(a[0], a.length === 3 ? a[1] : undefined, undefined, body)
          else { const hn = Number(a[a.length - 2]); pub(a[0], a.length === 4 ? a[1] : undefined, body.slice(0, hn), body.slice(hn)) }
          continue
        }
        i = e + 2
        if (verb === 'PING') { out('PONG\r\n'); continue }
        if (verb === 'PONG' || verb === 'CONNECT' || verb === '') { if (debug && verb === 'CONNECT') process.stderr.write(`nats CONNECT ${rest}\n`); continue }
        if (verb === 'SUB') {
          const a = rest.trim().split(/\s+/)
          sub(a[0], a.length === 3 ? a[1] : undefined, a[a.length - 1])
          continue
        }
        if (verb === 'UNSUB') {
          const a = rest.trim().split(/\s+/)
          const s = mine.get(a[0])
          if (s && a[1] !== undefined && Number(a[1]) > s.got) s.max = Number(a[1])
          else unsub(a[0])
          continue
        }
        stats.err('unknown-op')
        if (debug) process.stderr.write(`nats: unknown op ${line.slice(0, 80)}\n`)
        out(`-ERR 'Unknown Protocol Operation'\r\n`)
      }
      buf = i >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(i))
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      stats.conns--
      for (const sid of [...mine.keys()]) unsub(sid)
      subs.delete(conn)
      js.closed(conn)
    })
  })
  const [host, port] = (env.opts.listen ?? '127.0.0.1:14290').split(':')
  await new Promise<void>((r) => server.listen(Number(port), host, r))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }
}
