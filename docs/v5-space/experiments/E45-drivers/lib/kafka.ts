// kafka — a Kafka-protocol front over fero, so Kafka's own perf tools (producer, consumer,
// end-to-end latency) and any Kafka client, OpenMessaging Benchmark's Kafka driver included, can
// drive fero (PERF-05; PERF-06's fero side is the same). L5: built only from fero() and the verbs,
// plus env.ensure for topic creation (F2). Messages are encoded from Kafka's own specs (kafka-codec.ts).
//
//   topic T, N partitions   → a resource `kafka.T` (rows: false, history 'all'); partition i is the
//                              fero partition `p<i>`; N is kept in the row `T` of `kafka.$topics`
//   Produce (acks 1 or -1)  → each record batch is one set(`p<i>`, { b }) of its bytes, verbatim
//                              (CRC and records untouched), chained per (connection, partition) so
//                              they commit in the order sent (F4); the answer comes after commit. acks=1
//                              has no rung of its own in fero: it waits for the same commit (F7)
//   offsets                 → a batch's base offset is made from its version: (epoch, index) × 2^16,
//                              so offsets rise per partition with gaps, as on a compacted topic (F1)
//   Fetch, ListOffsets      → a log reader per partition from 'earliest' feeds an index of batches
//                              at the gateway; a fetch at offset X answers from it, and waits up to
//                              MaxWaitMs for new data (F1b: no read from a version, so no seek in fero)
//   groups (classic)        → the gateway is the coordinator: JoinGroup, SyncGroup, Heartbeat,
//                              LeaveGroup in its memory (F5: across gateways this is P-08's group());
//                              OffsetCommit and OffsetFetch are rows of `kafka.$offsets`, committed
//   InitProducerId          → an id; the producer's sequence numbers are not used to drop resends (F10)
//   CreateTopics, Metadata  → one broker (this gateway), every partition led by it

import net from 'node:net'
import { type GatewayEnv, KeyChains, codeOf } from './common.ts'
import { Codec, Reader, Writer, loadSpec, range, type Spec } from './kafka-codec.ts'

const SPECS = process.env.E45_KAFKA_SPECS ?? '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/e45-kafka-specs/common/message'

export const resources = (_o: Record<string, string>): [string, Record<string, unknown>][] =>
  [['kafka.$topics', {}], ['kafka.$offsets', {}]]

// the versions this gateway answers (no topic-id versions: Produce ≤ 12, Fetch ≤ 12, OffsetCommit
// and OffsetFetch ≤ 9; the client picks the highest both sides know)
const MAX: Record<string, number> = {
  Produce: 12, Fetch: 12, ListOffsets: 9, Metadata: 12, OffsetCommit: 9, OffsetFetch: 9, FindCoordinator: 6,
  JoinGroup: 9, Heartbeat: 4, LeaveGroup: 5, SyncGroup: 5, ApiVersions: 4, CreateTopics: 7, InitProducerId: 5,
}
const ERR = { NONE: 0, UNKNOWN_TOPIC: 3, REBALANCE: 27, ILLEGAL_GENERATION: 22, UNKNOWN_MEMBER: 25, UNSUPPORTED_VERSION: 35, TOPIC_EXISTS: 36, UNKNOWN: -1, MEMBER_ID_REQUIRED: 79, REQUEST_TIMED_OUT: 7 }

/** offsets: (epoch, index) of the batch's version, times 2^16, plus the record's delta */
const baseOf = (version: string): bigint => { const [e, i] = version.split(':'); return ((BigInt(parseInt(e, 16)) << 32n) + BigInt(parseInt(i, 16))) << 16n }

interface Batch { base: bigint; last: bigint; bytes: Buffer }
interface Part { batches: Batch[]; waiters: Set<() => void> }
interface Topic { name: string; n: number; res: any; parts: Part[] }
interface Member { id: string; protocols: { Name: string; Metadata: Buffer }[]; joined?: (r: any) => void; synced?: (a: Buffer) => void; assignment?: Buffer }
interface Group { id: string; gen: number; leader: string; members: Map<string, Member>; protocol: string; state: 'join' | 'sync' | 'stable'; timer?: NodeJS.Timeout }

export const start = async (env: GatewayEnv): Promise<{ close(): Promise<void>; port: number }> => {
  const { stats } = env
  const topicsRes = await env.fero('kafka.$topics')
  const offsetsRes = await env.fero('kafka.$offsets')
  const topics = new Map<string, Topic>()
  const groups = new Map<string, Group>()
  const defaultPartitions = Number(env.opts.partitions ?? 1)
  let producerIds = 1000
  let memberSeq = 0
  const [lhost, lport] = (env.opts.listen ?? '127.0.0.1:19290').split(':')
  let port = Number(lport)

  // the specs, by API key
  const req = new Map<number, { name: string; spec: Spec; c: Codec; res: Codec; min: number; max: number }>()
  for (const name of Object.keys(MAX)) {
    const rq = loadSpec(SPECS, name + 'Request'), rs = loadSpec(SPECS, name + 'Response')
    const [min, max] = range(rq.validVersions)
    req.set(rq.apiKey!, { name, spec: rq, c: new Codec(rq), res: new Codec(rs), min, max: Math.min(max, MAX[name]) })
  }
  const flexible = (spec: Spec, v: number): boolean => { const f = spec.flexibleVersions; return f !== 'none' && v >= Number(f.replace('+', '')) }

  // ── topics ─────────────────────────────────────────────────────────────
  const openTopic = async (name: string, n: number, copies?: number): Promise<Topic> => {
    let t = topics.get(name)
    if (t) return t
    const ropts: Record<string, unknown> = { rows: false, history: 'all' }
    if (copies && [1, 3, 5].includes(copies)) ropts.copies = copies
    await env.ensure('kafka.' + name, ropts)
    const res = await env.fero('kafka.' + name)
    t = { name, n, res, parts: Array.from({ length: n }, () => ({ batches: [], waiters: new Set<() => void>() })) }
    topics.set(name, t)
    await env.run(() => topicsRes.set(name, { partitions: n }))
    // one reader per partition feeds the gateway's index of batches (F1b)
    for (let i = 0; i < n; i++) {
      const r = env.run(() => res.read({ from: 'earliest', partitions: ['p' + i] }))
      const part = t.parts[i]
      void (async () => {
        try {
          for await (const e of r) {
            const bytes = Buffer.from((e.rec.value as { b: string }).b, 'latin1')
            const base = baseOf(e.version)
            const lastDelta = bytes.readInt32BE(23)
            part.batches.push({ base, last: base + BigInt(lastDelta), bytes })
            for (const w of [...part.waiters]) w()
          }
        } catch (err) { stats.err('read-' + codeOf(err)) }
      })()
    }
    stats.op('topic-create')
    return t
  }
  const hw = (p: Part): bigint => (p.batches.length ? p.batches[p.batches.length - 1].last + 1n : 0n)

  // ── handlers ───────────────────────────────────────────────────────────
  const H: Record<string, (r: any, v: number, cx: { chains: KeyChains }) => Promise<any>> = {
    ApiVersions: async () => ({ ErrorCode: 0, ApiKeys: [...req.entries()].map(([k, x]) => ({ ApiKey: k, MinVersion: x.min, MaxVersion: x.max })), ThrottleTimeMs: 0 }),
    Metadata: async (r) => {
      const want: string[] | null = r.Topics ? r.Topics.map((t: any) => t.Name) : null
      if (want && r.AllowAutoTopicCreation) for (const n of want) if (!topics.has(n)) await openTopic(n, defaultPartitions)
      const list = want ?? [...topics.keys()]
      return {
        Brokers: [{ NodeId: 1, Host: lhost, Port: port, Rack: null }], ClusterId: 'fero-e45', ControllerId: 1,
        Topics: list.map((n) => {
          const t = topics.get(n)
          if (!t) return { ErrorCode: ERR.UNKNOWN_TOPIC, Name: n, Partitions: [] }
          return { ErrorCode: 0, Name: n, IsInternal: false, Partitions: t.parts.map((_, i) => ({ ErrorCode: 0, PartitionIndex: i, LeaderId: 1, LeaderEpoch: 0, ReplicaNodes: [1], IsrNodes: [1], OfflineReplicas: [] })), TopicAuthorizedOperations: -2147483648 }
        }),
        ClusterAuthorizedOperations: -2147483648,
      }
    },
    CreateTopics: async (r) => ({
      Topics: await Promise.all(r.Topics.map(async (t: any) => {
        if (topics.has(t.Name)) return { Name: t.Name, ErrorCode: ERR.TOPIC_EXISTS, ErrorMessage: 'exists' }
        const n = t.NumPartitions > 0 ? t.NumPartitions : defaultPartitions
        if (!r.validateOnly) await openTopic(t.Name, n, t.ReplicationFactor > 0 ? t.ReplicationFactor : undefined)
        return { Name: t.Name, ErrorCode: 0, ErrorMessage: null, NumPartitions: n, ReplicationFactor: t.ReplicationFactor, Configs: [] }
      })),
    }),
    InitProducerId: async () => ({ ErrorCode: 0, ProducerId: BigInt(++producerIds), ProducerEpoch: 0 }),
    Produce: async (r, _v, cx) => {
      const out = await Promise.all(r.TopicData.map(async (td: any) => {
        const t = topics.get(td.Name) ?? (await openTopic(td.Name, defaultPartitions))
        return {
          Name: td.Name,
          PartitionResponses: await Promise.all(td.PartitionData.map(async (pd: any) => {
            if (pd.Index >= t.n) return { Index: pd.Index, ErrorCode: ERR.UNKNOWN_TOPIC, BaseOffset: -1n }
            const recs: Buffer = pd.Records ?? Buffer.alloc(0)
            let o = 0, first: bigint | null = null
            const sets: Promise<any>[] = []
            while (o + 61 <= recs.length) {
              const len = recs.readInt32BE(o + 8)
              const batch = recs.subarray(o, o + 12 + len)
              stats.op('kafka-batch'); stats.op('kafka-record', batch.readInt32BE(57))
              // a connection's batches to one partition commit in the order sent (F4: a chain per partition)
              const b = batch.toString('latin1')
              sets.push(cx.chains.run(td.Name + '/' + pd.Index, () => env.run(() => t.res.set('p' + pd.Index, { b }))))
              o += 12 + len
            }
            try {
              const acks = await Promise.all(sets)
              if (acks.length) first = baseOf(acks[0].version)
              return { Index: pd.Index, ErrorCode: 0, BaseOffset: first ?? -1n, LogAppendTimeMs: -1n, LogStartOffset: t.parts[pd.Index].batches[0]?.base ?? 0n, RecordErrors: [], ErrorMessage: null }
            } catch (e) {
              stats.err('produce-' + codeOf(e))
              return { Index: pd.Index, ErrorCode: ERR.REQUEST_TIMED_OUT, BaseOffset: -1n, ErrorMessage: 'fero ' + codeOf(e) }
            }
          })),
        }
      }))
      return { Responses: out, ThrottleTimeMs: 0 }
    },
    ListOffsets: async (r) => ({
      Topics: r.Topics.map((tp: any) => {
        const t = topics.get(tp.Name)
        return {
          Name: tp.Name,
          Partitions: tp.Partitions.map((p: any) => {
            if (!t || p.PartitionIndex >= t.n) return { PartitionIndex: p.PartitionIndex, ErrorCode: ERR.UNKNOWN_TOPIC }
            const part = t.parts[p.PartitionIndex]
            const ts = BigInt(p.Timestamp)
            const off = ts === -2n ? (part.batches[0]?.base ?? 0n) : hw(part)   // earliest, else latest (time lookups: F1b)
            return { PartitionIndex: p.PartitionIndex, ErrorCode: 0, Timestamp: -1n, Offset: off, LeaderEpoch: 0 }
          }),
        }
      }),
    }),
    Fetch: async (r) => {
      const deadline = Date.now() + Math.max(0, r.MaxWaitMs)
      const collect = () => {
        let bytes = 0
        const resp = r.Topics.map((tp: any) => {
          const t = topics.get(tp.Topic)
          return {
            Topic: tp.Topic,
            Partitions: tp.Partitions.map((p: any) => {
              if (!t || p.Partition >= t.n) return { PartitionIndex: p.Partition, ErrorCode: ERR.UNKNOWN_TOPIC, HighWatermark: -1n, Records: null }
              const part = t.parts[p.Partition]
              const at = BigInt(p.FetchOffset)
              const bs = part.batches
              let lo = 0, hi = bs.length
              while (lo < hi) { const m = (lo + hi) >> 1; if (bs[m].last < at) lo = m + 1; else hi = m }
              const chosen: Buffer[] = []
              let size = 0
              for (let i = lo; i < bs.length && (chosen.length === 0 || size + bs[i].bytes.length <= p.PartitionMaxBytes); i++) {
                const b = Buffer.from(bs[i].bytes)
                b.writeBigInt64BE(bs[i].base, 0)   // the batch's base offset is fero's; the CRC does not cover it
                b.writeInt32BE(0, 12)              // partition leader epoch
                chosen.push(b); size += b.length
              }
              bytes += size
              return { PartitionIndex: p.Partition, ErrorCode: 0, HighWatermark: hw(part), LastStableOffset: hw(part), LogStartOffset: bs[0]?.base ?? 0n, AbortedTransactions: null, PreferredReadReplica: -1, Records: chosen.length ? Buffer.concat(chosen) : Buffer.alloc(0) }
            }),
          }
        })
        return { bytes, resp }
      }
      for (;;) {
        const { bytes, resp } = collect()
        if (bytes >= Math.max(1, r.MinBytes) || Date.now() >= deadline) {
          stats.op('fetch'); if (bytes > 0) stats.op('fetch-bytes', bytes)
          return { ThrottleTimeMs: 0, ErrorCode: 0, SessionId: 0, Responses: resp }
        }
        // long poll: woken by a new batch on any asked partition, or the deadline
        await new Promise<void>((res) => {
          const parts: Part[] = []
          for (const tp of r.Topics) { const t = topics.get(tp.Topic); if (t) for (const p of tp.Partitions) if (p.Partition < t.n) parts.push(t.parts[p.Partition]) }
          const done = () => { clearTimeout(tm); for (const p of parts) p.waiters.delete(done); res() }
          const tm = setTimeout(done, Math.max(1, deadline - Date.now()))
          for (const p of parts) p.waiters.add(done)
        })
      }
    },
    FindCoordinator: async (r, v) => v >= 4
      ? { Coordinators: (r.CoordinatorKeys ?? []).map((k: string) => ({ Key: k, NodeId: 1, Host: lhost, Port: port, ErrorCode: 0, ErrorMessage: null })) }
      : { ErrorCode: 0, ErrorMessage: null, NodeId: 1, Host: lhost, Port: port },
    JoinGroup: async (r, v) => {
      stats.op('join')
      let g = groups.get(r.GroupId)
      if (!g) { g = { id: r.GroupId, gen: 0, leader: '', members: new Map(), protocol: '', state: 'stable' }; groups.set(r.GroupId, g) }
      let id = r.MemberId
      if (!id) {
        id = `${r.GroupId}-m${++memberSeq}`
        if (v >= 4) return { ErrorCode: ERR.MEMBER_ID_REQUIRED, GenerationId: -1, ProtocolName: null, Leader: '', MemberId: id, Members: [] }
      }
      const gg = g
      return await new Promise((resolve) => {
        gg.members.set(id, { id, protocols: r.Protocols, joined: resolve })
        gg.state = 'join'
        // a join window: every member that joins within it is in the generation (one gateway's memory: F5)
        clearTimeout(gg.timer)
        gg.timer = setTimeout(() => {
          gg.gen++; gg.state = 'sync'
          const ms = [...gg.members.values()]
          gg.leader = ms[0].id
          gg.protocol = ms[0].protocols[0].Name
          for (const m of ms) {
            m.joined?.({ ErrorCode: 0, GenerationId: gg.gen, ProtocolType: 'consumer', ProtocolName: gg.protocol, Leader: gg.leader, SkipAssignment: false, MemberId: m.id, Members: m.id === gg.leader ? ms.map((x) => ({ MemberId: x.id, GroupInstanceId: null, Metadata: x.protocols.find((p) => p.Name === gg.protocol)?.Metadata ?? Buffer.alloc(0) })) : [] })
            m.joined = undefined
          }
        }, 100)
      })
    },
    SyncGroup: async (r) => {
      const g = groups.get(r.GroupId)
      if (!g || !g.members.has(r.MemberId)) return { ErrorCode: ERR.UNKNOWN_MEMBER, Assignment: Buffer.alloc(0) }
      if (r.GenerationId !== g.gen) return { ErrorCode: ERR.ILLEGAL_GENERATION, Assignment: Buffer.alloc(0) }
      const m = g.members.get(r.MemberId)!
      if (r.MemberId === g.leader) {
        for (const a of r.Assignments) { const x = g.members.get(a.MemberId); if (x) { x.assignment = a.Assignment; x.synced?.(a.Assignment); x.synced = undefined } }
        g.state = 'stable'
      }
      const a = m.assignment ?? await new Promise<Buffer>((res) => { m.synced = res })
      return { ErrorCode: 0, ProtocolType: 'consumer', ProtocolName: g.protocol, Assignment: a }
    },
    Heartbeat: async (r) => {
      const g = groups.get(r.GroupId)
      if (!g || !g.members.has(r.MemberId)) return { ErrorCode: ERR.UNKNOWN_MEMBER }
      if (r.GenerationId !== g.gen) return { ErrorCode: ERR.ILLEGAL_GENERATION }
      return { ErrorCode: g.state === 'stable' ? 0 : ERR.REBALANCE }
    },
    LeaveGroup: async (r, v) => {
      const g = groups.get(r.GroupId)
      const ids: string[] = v >= 3 ? r.Members.map((m: any) => m.MemberId) : [r.MemberId]
      for (const id of ids) g?.members.delete(id)
      if (g && g.members.size > 0) g.state = 'join'
      return { ErrorCode: 0, Members: ids.map((id) => ({ MemberId: id, GroupInstanceId: null, ErrorCode: 0 })) }
    },
    OffsetCommit: async (r) => {
      const g = groups.get(r.GroupId)
      const fenced = g && r.GenerationIdOrMemberEpoch >= 0 && r.GenerationIdOrMemberEpoch !== g.gen
      return {
        Topics: await Promise.all(r.Topics.map(async (t: any) => ({
          Name: t.Name,
          Partitions: await Promise.all(t.Partitions.map(async (p: any) => {
            if (fenced) return { PartitionIndex: p.PartitionIndex, ErrorCode: ERR.ILLEGAL_GENERATION }
            try {
              await env.run(() => offsetsRes.set(`${r.GroupId}/${t.Name}/${p.PartitionIndex}`, { offset: String(p.CommittedOffset), meta: p.CommittedMetadata ?? '' }))
              stats.op('offset-commit')
              return { PartitionIndex: p.PartitionIndex, ErrorCode: 0 }
            } catch (e) { stats.err('commit-' + codeOf(e)); return { PartitionIndex: p.PartitionIndex, ErrorCode: ERR.REQUEST_TIMED_OUT } }
          })),
        }))),
      }
    },
    OffsetFetch: async (r, v) => {
      const one = async (gid: string, ts: any[] | null) => {
        const list = ts ?? [...topics.values()].map((t) => ({ Name: t.name, PartitionIndexes: t.parts.map((_, i) => i) }))
        return Promise.all(list.map(async (t: any) => ({
          Name: t.Name,
          Partitions: await Promise.all(t.PartitionIndexes.map(async (i: number) => {
            const row = await env.run(() => offsetsRes.get(`${gid}/${t.Name}/${i}`)) as { offset: string; meta: string } | undefined
            return { PartitionIndex: i, CommittedOffset: row ? BigInt(row.offset) : -1n, CommittedLeaderEpoch: -1, Metadata: row?.meta ?? '', ErrorCode: 0 }
          })),
        })))
      }
      if (v >= 8) return { Groups: await Promise.all(r.Groups.map(async (g: any) => ({ GroupId: g.GroupId, Topics: await one(g.GroupId, g.Topics), ErrorCode: 0 }))) }
      return { Topics: await one(r.GroupId, r.Topics), ErrorCode: 0 }
    },
  }

  // ── framing ────────────────────────────────────────────────────────────
  const server = net.createServer((sock) => {
    stats.conns++
    sock.setNoDelay(true)
    let buf: Buffer = Buffer.alloc(0)
    // responses go out in request order (Kafka's rule per connection)
    const pending: { done: boolean; b: Buffer | null }[] = []
    const flush = () => { while (pending.length && pending[0].done) { const x = pending.shift()!; if (x.b) { stats.bytesOut += x.b.length; sock.write(x.b) } } }
    const cx = { chains: new KeyChains() }
    const handle = (frame: Buffer): void => {
      const rd = new Reader(frame)
      const key = rd.i16(), v = rd.i16(), corr = rd.i32()
      const cidLen = rd.i16(); if (cidLen > 0) rd.raw(cidLen)
      const api = req.get(key)
      const slot = { done: false, b: null as Buffer | null }
      pending.push(slot)
      const reply = (body: Buffer, flex: boolean) => {
        const w = new Writer().i32(0).i32(corr)
        if (flex) w.uvar(0)
        w.push(body)
        const b = w.buf(); b.writeInt32BE(b.length - 4, 0)
        slot.b = b; slot.done = true; flush()
      }
      if (!api) { stats.err('api-' + key); if (debug) process.stderr.write(`kafka: unknown api ${key} v${v}\n`); sock.destroy(); return }
      stats.op(api.name)
      if (api.name === 'ApiVersions' && v > api.max) {
        // unsupported ApiVersions: answer v0 with the error and our ranges; the client retries lower
        void H.ApiVersions({}, 0, cx).then((x) => reply(api.res.encode({ ...x, ErrorCode: ERR.UNSUPPORTED_VERSION }, 0), false))
        return
      }
      const flex = flexible(api.spec, v)
      if (flex) { const n = rd.uvar(); for (let i = 0; i < n; i++) { rd.uvar(); rd.raw(rd.uvar()) } }
      let body: any
      try { body = api.c.decode(rd, v) } catch (e) { stats.err('decode-' + api.name); if (debug) process.stderr.write(`kafka: decode ${api.name} v${v}: ${e}\n`); sock.destroy(); return }
      if (debug) process.stderr.write(`kafka: ${api.name} v${v}\n`)
      if (api.name === 'Produce' && body.Acks === 0) { slot.done = true; void H.Produce(body, v, cx); flush(); return }
      H[api.name](body, v, cx).then(
        (res) => reply(api.res.encode(res, v), api.name === 'ApiVersions' ? false : flex),
        (e) => { stats.err(api.name + '-' + codeOf(e)); if (debug) process.stderr.write(`kafka: ${api.name} failed: ${e?.stack ?? e}\n`); sock.destroy() },
      )
    }
    sock.on('data', (d: Buffer) => {
      stats.bytesIn += d.length
      buf = buf.length === 0 ? d : Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const n = buf.readInt32BE(0)
        if (buf.length < 4 + n) break
        const frame = Buffer.from(buf.subarray(4, 4 + n))
        buf = buf.subarray(4 + n)
        handle(frame)
      }
      if (buf.length === 0) buf = Buffer.alloc(0)
    })
    sock.on('error', () => {})
    sock.on('close', () => { stats.conns-- })
  })
  const debug = !!process.env.E45_DEBUG
  await new Promise<void>((r) => server.listen(port, lhost, r))
  port = (server.address() as net.AddressInfo).port
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}
