// jetstream — the subset of NATS JetStream that `nats bench js` and `nats stream add` use, over
// fero (PERF-04). L5: built only from fero() and the verbs, plus env.ensure (F2).
//
//   $JS.API.INFO                         → account info (counts this gateway keeps)
//   $JS.API.STREAM.CREATE|UPDATE.<s>     → a fero resource `js.<s>`, created on every server:
//        retention limits   → rows: false, history: max_bytes (else 'all'); the subject is the partition
//        retention workqueue→ rows, partition: { before: '/' }; a message is the row `<subject>/<id>`
//   $JS.API.STREAM.INFO|DELETE|PURGE.<s> → what the gateway knows (DELETE and PURGE are refused:
//        fero.drop and a purge are not wired here)
//   publish to a stream subject          → set(); the PubAck after commit carries `seq`, a number
//        made from the version (F1: versions have no documented numeric form)
//   $JS.API.CONSUMER.CREATE|DURABLE.CREATE|INFO|DELETE.<s>.<c>
//   $JS.API.CONSUMER.MSG.NEXT.<s>.<c>    → a pull:
//        limits stream    → the consumer's own log reader, read({ partitions, from: cursor }); the
//                            cursor is kept in the row `<s>.<c>` of `js.$consumers` after each pull
//        workqueue stream → claim({ partition, n: batch, lease: ack_wait }) (P-09, as queue() does)
//   $JS.ACK.<s>.<c>.<n>.<sseq>.<cseq>.<ts>.<pending>  → limits: counted; workqueue: remove(key,
//        { if: { version: token } }), so a lapsed lease taken again refuses the stale ack
// Not mapped (F6): redelivery on ack_wait for limits streams, max_ack_pending, push consumers,
// mirrors and sources, Nats-Msg-Id dedup (fero dedups by attempt, not by a user's id), direct get.

import type { GatewayEnv } from './common.ts'
import { codeOf, KeyChains } from './common.ts'
import { matches, type Conn } from './nats.ts'

const T = 'io.nats.jetstream.api.v1.'
const iso = (ms: number): string => new Date(ms).toISOString().replace('Z', '000000Z')
/** a version as a number (epoch, then the log index): see F1 */
export const verNum = (v: string): number => { const [e, i] = v.split(':'); return parseInt(e, 16) * 2 ** 40 + parseInt(i, 16) }

interface Stream {
  name: string; cfg: Record<string, any>; res: any; wq: boolean; created: number
  msgs: number; bytes: number; first: number; last: number; firstT: number; lastT: number
  consumers: Map<string, Consumer>
}
interface Consumer {
  name: string; stream: Stream; cfg: Record<string, any>; created: number
  delivered: number; acked: number; ackFloor: number
  // limits streams: a reader pumped into a buffer
  buf: { subject: string; d: string; h?: string; seq: number }[]; reader?: any; cursor?: string; wake?: () => void
  // workqueue: what each delivered consumer seq holds
  held: Map<number, { key: string; token: string }>
}

export class JetStream {
  readonly env: GatewayEnv
  readonly streams = new Map<string, Stream>()
  #consumersRes: any = null
  #chains = new WeakMap<Conn, KeyChains>()
  constructor(env: GatewayEnv) { this.env = env }

  owns(subject: string): boolean {
    if (subject.startsWith('$JS.')) return true
    for (const s of this.streams.values()) for (const p of s.cfg.subjects ?? []) if (matches(p, subject)) return true
    return false
  }
  closed(_c: Conn): void {}

  publish(c: Conn, subject: string, reply: string | undefined, h: string | undefined, d: string): void {
    const { stats } = this.env
    if (subject.startsWith('$JS.API.')) { stats.op('js-api'); void this.#api(c, subject.slice(8), reply, d).catch((e) => { stats.err('js-api-' + codeOf(e)); if (reply) c.respond(reply, JSON.stringify({ error: { code: 500, err_code: 10000, description: String(e?.message ?? e) } })) }); return }
    if (subject.startsWith('$JS.ACK.')) { stats.op('js-ack'); this.#ack(subject, d); return }
    if (subject.startsWith('$JS.')) { stats.op('js-other'); return }
    const s = [...this.streams.values()].find((x) => (x.cfg.subjects ?? []).some((p: string) => matches(p, subject)))!
    stats.op('js-pub')
    const v: Record<string, string> = { d }
    if (h !== undefined) v.h = h
    const key = s.wq ? `${subject}/${this.env.id()}` : subject
    // a connection's publishes to one subject commit in the order sent (F4: a chain per subject)
    let chains = this.#chains.get(c)
    if (!chains) { chains = new KeyChains(); this.#chains.set(c, chains) }
    chains.run(subject, () => this.env.run(() => s.res.set(key, v))).then((ack: any) => {
      const seq = verNum(ack.version)
      const t = this.env.now()
      s.msgs++; s.bytes += d.length + (h?.length ?? 0) + subject.length; s.last = Math.max(s.last, seq); s.lastT = t
      if (!s.first) { s.first = seq; s.firstT = t }
      for (const cn of s.consumers.values()) cn.wake?.()
      if (reply) c.respond(reply, `{"stream":${JSON.stringify(s.name)}, "seq":${seq}}`)
    }, (e: unknown) => {
      stats.err('js-pub-' + codeOf(e))
      if (reply) c.respond(reply, JSON.stringify({ error: { code: 503, err_code: 10077, description: 'fero ' + codeOf(e) } }))
    })
  }

  #info(s: Stream, type = 'stream_info_response', extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...extra,
      type: T + type, total: 0, offset: 0, limit: 0, config: s.cfg, created: iso(s.created),
      state: { messages: s.msgs, bytes: s.bytes, first_seq: s.first, first_ts: iso(s.firstT), last_seq: s.last, last_ts: iso(s.lastT), num_subjects: 1, consumer_count: s.consumers.size },
      cluster: { leader: 's1' }, ts: iso(Date.now()),
    })
  }
  #cinfo(cn: Consumer, type = 'consumer_info_response'): string {
    return JSON.stringify({
      type: T + type, stream_name: cn.stream.name, name: cn.name, created: iso(cn.created), config: cn.cfg,
      delivered: { consumer_seq: cn.delivered, stream_seq: cn.delivered }, ack_floor: { consumer_seq: cn.acked, stream_seq: cn.ackFloor },
      num_ack_pending: cn.delivered - cn.acked, num_redelivered: 0, num_waiting: 0, num_pending: Math.max(0, cn.stream.msgs - cn.delivered), ts: iso(Date.now()),
    })
  }
  #err(type: string, code: number, err: number, desc: string): string {
    return JSON.stringify({ type: T + type, error: { code, err_code: err, description: desc } })
  }

  async #api(c: Conn, api: string, reply: string | undefined, body: string): Promise<void> {
    const say = (s: string): void => { if (reply) c.respond(reply, s) }
    const parts = api.split('.')
    const req = body.trim() ? JSON.parse(body) : {}
    if (api === 'INFO') {
      say(JSON.stringify({ type: T + 'account_info_response', memory: 0, storage: [...this.streams.values()].reduce((a, s) => a + s.bytes, 0), reserved_memory: 0, reserved_storage: 0, streams: this.streams.size, consumers: [...this.streams.values()].reduce((a, s) => a + s.consumers.size, 0), limits: { max_memory: -1, max_storage: -1, max_streams: -1, max_consumers: -1, max_ack_pending: -1, memory_max_stream_bytes: -1, storage_max_stream_bytes: -1, max_bytes_required: false }, api: { total: 0, errors: 0 } }))
      return
    }
    if (parts[0] === 'STREAM') {
      const op = parts[1], name = parts.slice(2).join('.')
      if (op === 'NAMES' || op === 'LIST') { say(JSON.stringify({ type: T + 'stream_names_response', total: this.streams.size, offset: 0, limit: 1024, streams: [...this.streams.keys()] })); return }
      const s = this.streams.get(name)
      if (op === 'CREATE' || op === 'UPDATE') {
        if (s) { say(this.#info(s, 'stream_create_response')); return }
        const cfg = { retention: 'limits', max_consumers: -1, max_msgs: -1, max_bytes: -1, max_age: 0, max_msgs_per_subject: -1, max_msg_size: -1, discard: 'old', storage: 'file', num_replicas: 1, duplicate_window: 120000000000, compression: 'none', allow_direct: false, mirror_direct: false, sealed: false, deny_delete: false, deny_purge: false, allow_rollup_hdrs: false, consumer_limits: {}, ...req, name }
        if (!cfg.subjects || cfg.subjects.length === 0) cfg.subjects = [name]
        const wq = cfg.retention === 'workqueue'
        // fero keys: copies follow num_replicas (1, 3 or 5); file storage = persisted, memory storage
        // has no fero rung for rows (F7); history = max_bytes when set
        const ropts: Record<string, unknown> = wq ? { partition: { before: '/' } } : { rows: false, history: cfg.max_bytes > 0 ? `${cfg.max_bytes}B` as const : 'all' }
        if ([1, 3, 5].includes(cfg.num_replicas)) ropts.copies = cfg.num_replicas
        await this.env.ensure('js.' + name, ropts)
        const res = await this.env.fero('js.' + name)
        const t = this.env.now()
        const ns: Stream = { name, cfg, res, wq, created: t, msgs: 0, bytes: 0, first: 0, last: 0, firstT: 0, lastT: 0, consumers: new Map() }
        this.streams.set(name, ns)
        this.env.stats.op('js-stream-create')
        say(this.#info(ns, 'stream_create_response', { did_create: true }))
        return
      }
      if (!s) { say(this.#err('stream_info_response', 404, 10059, 'stream not found')); return }
      if (op === 'INFO') { say(this.#info(s)); return }
      say(this.#err(`stream_${op.toLowerCase()}_response`, 400, 10000, `fero gateway: STREAM.${op} is not mapped`))
      return
    }
    if (parts[0] === 'CONSUMER') {
      let op = parts[1], rest = parts.slice(2)
      if (op === 'DURABLE' && rest[0] === 'CREATE') { op = 'CREATE'; rest = rest.slice(1) }
      if (op === 'MSG' && rest[0] === 'NEXT') { op = 'NEXT'; rest = rest.slice(1) }
      const s = this.streams.get(rest[0])
      if (!s) { say(this.#err('consumer_info_response', 404, 10059, 'stream not found')); return }
      if (op === 'NAMES' || op === 'LIST') { say(JSON.stringify({ type: T + 'consumer_names_response', total: s.consumers.size, offset: 0, limit: 1024, consumers: [...s.consumers.keys()] })); return }
      const cname = rest[1] ?? req.config?.durable_name ?? req.config?.name ?? this.env.id()
      let cn = s.consumers.get(cname)
      if (op === 'CREATE') {
        if (!cn) {
          const cfg = { ack_policy: 'explicit', ack_wait: 30000000000, max_deliver: -1, deliver_policy: 'all', replay_policy: 'instant', max_waiting: 512, max_ack_pending: 1000, num_replicas: 0, ...req.config }
          cn = { name: cname, stream: s, cfg, created: this.env.now(), delivered: 0, acked: 0, ackFloor: 0, buf: [], held: new Map() }
          s.consumers.set(cname, cn)
          if (!s.wq) await this.#openReader(cn)
          this.env.stats.op('js-consumer-create')
        }
        say(this.#cinfo(cn, 'consumer_create_response'))
        return
      }
      if (!cn) { say(this.#err('consumer_info_response', 404, 10014, 'consumer not found')); return }
      if (op === 'INFO') { say(this.#cinfo(cn)); return }
      if (op === 'DELETE') { cn.reader?.close(); s.consumers.delete(cname); say(JSON.stringify({ type: T + 'consumer_delete_response', success: true })); return }
      if (op === 'NEXT') { if (reply) await this.#pull(c, cn, reply, req); return }
      say(this.#err('consumer_info_response', 400, 10000, `fero gateway: CONSUMER.${op} is not mapped`))
      return
    }
    say(this.#err('api_response', 400, 10000, `fero gateway: ${api} is not mapped`))
  }

  async #consumers(): Promise<any> {
    if (!this.#consumersRes) { await this.env.ensure('js.$consumers', {}); this.#consumersRes = await this.env.fero('js.$consumers') }
    return this.#consumersRes
  }
  async #openReader(cn: Consumer): Promise<void> {
    const store = await this.#consumers()
    const saved = await this.env.run(() => store.get(`${cn.stream.name}.${cn.name}`)) as { cursor?: string } | undefined
    const subjects: string[] = cn.cfg.filter_subject ? [cn.cfg.filter_subject] : cn.stream.cfg.subjects
    const literal = subjects.every((x) => !x.includes('*') && !x.includes('>'))
    const from = saved?.cursor ?? (cn.cfg.deliver_policy === 'new' ? 'latest' : 'earliest')
    const r = this.env.run(() => cn.stream.res.read(literal ? { from, partitions: subjects } : { from }))
    cn.reader = r
    void (async () => {
      try {
        for await (const e of r) {
          const subject = String(e.partition)
          if (!subjects.some((p) => matches(p, subject))) continue
          const v = e.rec.value as { d: string; h?: string }
          cn.buf.push({ subject, d: v.d, h: v.h, seq: verNum(e.version) })
          cn.wake?.()
        }
      } catch (err) { this.env.stats.err('js-read-' + codeOf(err)) }
    })()
  }

  /** one pull request: up to `batch` messages, waiting up to `expires` for the first */
  async #pull(c: Conn, cn: Consumer, inbox: string, req: { batch?: number; expires?: number; no_wait?: boolean; idle_heartbeat?: number }): Promise<void> {
    const { stats } = this.env
    const batch = req.batch ?? 1
    const expires = (req.expires ?? 0) / 1e6   // ns → ms
    const until = Date.now() + (expires > 0 ? expires : 30_000)
    const hb = (req.idle_heartbeat ?? 0) / 1e6
    let lastHb = Date.now()
    const send = (m: { subject: string; d: string; h?: string }, sseq: number, cseq: number, pending: number): void => {
      stats.op('js-deliver')
      c.toInbox(inbox, { subject: m.subject, d: m.d, h: m.h, reply: `$JS.ACK.${cn.stream.name}.${cn.name}.1.${sseq}.${cseq}.${Date.now()}000000.${pending}` })
    }
    let sent = 0
    for (;;) {
      if (cn.stream.wq) {
        const lease = Math.max(1, Math.round((cn.cfg.ack_wait ?? 30e9) / 1e6))
        const subjects: string[] = cn.cfg.filter_subject ? [cn.cfg.filter_subject] : cn.stream.cfg.subjects
        for (const subject of subjects) {
          if (sent >= batch) break
          let got: any[] = []
          try { got = await this.env.run(() => cn.stream.res.claim({ partition: subject, n: batch - sent, lease })) } catch (e) { stats.err('js-claim-' + codeOf(e)) }
          for (const m of got) {
            const cseq = ++cn.delivered
            cn.held.set(cseq, { key: m.key, token: m.token })
            send({ subject, d: m.value.d, h: m.value.h }, verNum(m.token), cseq, 0)
            sent++
          }
        }
      } else {
        while (sent < batch && cn.buf.length > 0) {
          const m = cn.buf.shift()!
          const cseq = ++cn.delivered
          send(m, m.seq, cseq, cn.buf.length)
          sent++
        }
        if (sent > 0 && cn.reader) {
          // the consumer's position is a fero cursor, kept in a row so another gateway can resume it
          const store = await this.#consumers()
          const cursor = cn.reader.cursor
          void this.env.run(() => store.set(`${cn.stream.name}.${cn.name}`, { cursor })).catch((e: unknown) => stats.err('js-cursor-' + codeOf(e)))
        }
      }
      if (sent >= batch || (sent > 0 && cn.stream.wq) || req.no_wait || Date.now() >= until) break
      if (sent > 0 && cn.buf.length === 0) break
      // wait: woken by a publish through this gateway or a new entry, else poll (claims are not woken: P-22's waiting take is L5)
      await new Promise<void>((r) => { const t = setTimeout(r, cn.stream.wq ? 5 : 50); cn.wake = () => { clearTimeout(t); cn.wake = undefined; r() } })
      if (hb > 0 && Date.now() - lastHb >= hb) { lastHb = Date.now(); c.toInbox(inbox, { subject: inbox, d: '', h: 'NATS/1.0 100 Idle Heartbeat\r\n\r\n' }) }
    }
    if (sent < batch) {
      // end this pull early, as the server does when a request expires (the client returns what it got)
      c.toInbox(inbox, { subject: inbox, d: '', h: sent === 0 && req.no_wait ? 'NATS/1.0 404 No Messages\r\n\r\n' : 'NATS/1.0 408 Request Timeout\r\nNats-Pending-Messages: ' + (batch - sent) + '\r\nNats-Pending-Bytes: 0\r\n\r\n' })
    }
  }

  #ack(subject: string, body: string): void {
    const t = subject.split('.')   // $JS ACK stream consumer n sseq cseq ts pending
    const s = this.streams.get(t[2]); const cn = s?.consumers.get(t[3])
    if (!cn) return
    const cseq = Number(t[6])
    if (body.startsWith('-NAK') || body.startsWith('+WPI')) return   // a nak or in-progress: the lease runs out or is kept (F6)
    cn.acked++
    if (!s!.wq) { cn.ackFloor = Math.max(cn.ackFloor, Number(t[5])); return }
    const h = cn.held.get(cseq)
    if (!h) return
    cn.held.delete(cseq)
    this.env.run(() => s!.res.remove(h.key, { if: { version: h.token } })).then(() => { s!.msgs-- }, (e: unknown) => this.env.stats.err('js-ack-' + codeOf(e)))
  }
}
