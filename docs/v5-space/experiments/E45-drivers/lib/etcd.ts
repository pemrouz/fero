// etcd — an etcd v3 gRPC front over fero, so etcd's own `benchmark` tool (put, range, txn-put,
// stm, lease-keepalive) can drive fero (PERF-07). L5: built only from fero() and the verbs; the
// gRPC server is @grpc/grpc-js from npm (fetch.sh), with etcd's own message definitions
// (proto/etcd-subset.proto, derived from etcd v3.5.17 by proto/trim.py).
//
//   Put k v [lease]          → set(k, v[, { ttl: lease's ttl }]); mod_revision = the version as a number (F1)
//   Range k (serializable)   → get(k): a held-row read at the gateway (it is a server)
//   Range k (linearizable)   → get(k, { fresh: true }): the writer confirms it leads, no fsync
//   Range k..end, prefix     → the gateway's held rows (a sync read); no one-revision cut across
//                              partitions exists, so a linearizable multi-key range is refused (F8)
//   DeleteRange k            → remove(k)
//   Txn, one partition       → compares become conditions: MOD = r → if: { version }, MOD = 0 or
//                              CREATE = 0 or VERSION = 0 → if: { absent }, VALUE = x → if: { equals };
//                              the puts and deletes become one batch() (all or none); reads run after.
//                              Not succeeded = the batch was refused 'conflict', then the else-ops run.
//                              GREATER, LESS, NOT_EQUAL, and Txns across partitions are refused (F8).
//   LeaseGrant id ttl        → set(`lease/<id>`, { ttl }, { ttl }) in `etcd.leases`
//   LeaseKeepAlive id        → touch(`lease/<id>`, { ttl }), and touch each key put with that lease
//                              (a commit per keep-alive; etcd keeps keep-alives on its leader: F9)
//   LeaseRevoke id           → remove the lease row and its keys
//   Maintenance.Status, Cluster.MemberList → one member that leads (the tool's --target-leader asks)
// Watch is not served (UNIMPLEMENTED): no PERF-07 row uses it; the lock row is driven by a port
// of the lock loop over fero's lock() (ports/lockloop.ts), as PERF-07 says ("vs the locks library").

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { type GatewayEnv, codeOf } from './common.ts'

const NPM = process.env.E45_NPM ?? '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/e45-npm/'
const req = createRequire(NPM.endsWith('/') ? NPM : NPM + '/')
const grpc = req('@grpc/grpc-js')
const loader = req('@grpc/proto-loader')
const HERE = dirname(fileURLToPath(import.meta.url))

export const resources = (o: Record<string, string>): [string, Record<string, unknown>][] => [
  [o.resource ?? 'etcd', { partition: { before: '/' } }],   // keys under one 'dir/' are one partition (a lock's waiters)
  ['etcd.leases', { partition: { before: '/' } }],
]

/** a version as an int64-sized number and back (F1: the API keeps versions opaque) */
const verNum = (v: string): number => { if (!v) return 0; const [e, i] = v.split(':'); return parseInt(e, 16) * 2 ** 40 + parseInt(i, 16) }
const numVer = (n: number): string => Math.floor(n / 2 ** 40).toString(16).padStart(4, '0') + ':' + (n % 2 ** 40).toString(16).padStart(12, '0')
const partOf = (k: string): string => { const i = k.indexOf('/'); return i < 0 ? k : k.slice(0, i) }

const CLUSTER = 0xfe20, MEMBER = 0x51
class Refuse extends Error { readonly grpcCode: number; constructor(code: number, m: string) { super(m); this.grpcCode = code } }

export const start = async (env: GatewayEnv): Promise<{ close(): Promise<void>; port: number }> => {
  const name = env.opts.resource ?? 'etcd'
  const kv = await env.fero(name)
  const leases = await env.fero('etcd.leases')
  const { stats } = env
  let rev = 1
  const seen = (n: number): number => { if (n > rev) rev = n; return n }
  const header = (r?: number) => ({ cluster_id: CLUSTER, member_id: MEMBER, revision: r ?? rev, raft_term: 1 })
  const attached = new Map<string, { ttl: number; keys: Set<string> }>()   // lease id → ttl, keys (gateway memory: F9)
  let leaseSeq = 0

  const s = (b: Buffer | string | undefined): string => (b === undefined ? '' : typeof b === 'string' ? b : b.toString('latin1'))
  const kvOf = (key: string, value: unknown, version: string, lease = 0) => {
    const n = verNum(version)
    return { key: Buffer.from(key, 'latin1'), create_revision: n, mod_revision: n, version: 1, value: Buffer.from(String(value), 'latin1'), lease }
  }

  // ── KV ──────────────────────────────────────────────────────────────────
  const range = async (r: any) => {
    const key = s(r.key), end = s(r.range_end)
    const fresh = !r.serializable
    if (!end) {
      const got = await env.run(() => kv.get(key, { version: true, ...(fresh ? { fresh: true } : {}) })) as { value: unknown; version: string } | undefined
      stats.op(fresh ? 'range-l' : 'range-s')
      if (!got) return { header: header(0), kvs: [], more: false, count: 0 }   // revision 0 = "absent" (see Txn's compares)
      const lease = Number(leaseOfKey.get(key) ?? 0)
      return { header: header(seen(verNum(got.version))), kvs: r.count_only ? [] : [kvOf(key, got.value, got.version, lease)], more: false, count: 1 }
    }
    // a range: the rows this gateway holds, in key order. One partition, or serializable only.
    const all = end === '\u0000'
    const lo = key, hi = end
    const parts = new Set<string>()
    const out: any[] = []
    const snap = kv.snapshot as Record<string, unknown>
    for (const k of Object.keys(snap).sort()) {
      if (k < lo || (!all && k >= hi)) continue
      parts.add(partOf(k))
      out.push(k)
    }
    if (fresh && parts.size > 1) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a linearizable range across partitions has no fero form (F8)')
    stats.op(fresh ? 'range-l-many' : 'range-s-many')
    const rows = await Promise.all(out.map((k) => env.run(() => kv.get(k, { version: true, ...(fresh ? { fresh: true } : {}) })) as Promise<{ value: unknown; version: string } | undefined>))
    let kvs = out.map((k, i) => (rows[i] ? kvOf(k, rows[i]!.value, rows[i]!.version, Number(leaseOfKey.get(k) ?? 0)) : null)).filter(Boolean) as any[]
    if (r.sort_target === 0 && r.sort_order === 2) kvs.reverse()
    if (r.sort_target === 1 || r.sort_target === 2) kvs.sort((a, b) => a.mod_revision - b.mod_revision)   // CREATE and MOD: one partition only
    if (r.sort_order === 2 && r.sort_target !== 0) kvs.reverse()
    if (Number(r.max_create_revision) > 0) kvs = kvs.filter((x) => x.create_revision <= Number(r.max_create_revision))
    const count = kvs.length
    const limit = Number(r.limit ?? 0)
    if (limit > 0) kvs = kvs.slice(0, limit)
    return { header: header(), kvs: r.count_only ? [] : kvs, more: limit > 0 && count > limit, count }
  }
  const leaseOfKey = new Map<string, string>()
  const put = async (r: any) => {
    const key = s(r.key), value = s(r.value)
    const lease = String(r.lease ?? '0')
    const opts: Record<string, unknown> = {}
    if (lease !== '0') {
      const L = attached.get(lease)
      if (!L) throw new Refuse(grpc.status.NOT_FOUND, 'etcdserver: requested lease not found')
      opts.ttl = L.ttl * 1000; L.keys.add(key); leaseOfKey.set(key, lease)
    }
    const a = await env.run(() => kv.set(key, value, opts))
    stats.op('put')
    return { header: header(seen(verNum(a.version))) }
  }
  const del = async (r: any) => {
    const key = s(r.key)
    if (r.range_end && r.range_end.length > 0) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a DeleteRange over many keys is not one write (F8)')
    const had = await env.run(() => kv.get(key))
    const a = await env.run(() => kv.remove(key))
    stats.op('delete')
    return { header: header(seen(verNum(a.version))), deleted: had === undefined ? 0 : 1 }
  }
  /** an etcd Compare as a fero condition, or a refusal */
  const cond = (c: any): { key: string; if: Record<string, unknown> } => {
    const key = s(c.key)
    if (c.range_end && c.range_end.length > 0) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a compare over a range (F8)')
    const result = c.result ?? 0  // EQUAL 0, GREATER 1, LESS 2, NOT_EQUAL 3
    const target = c.target ?? 0  // VERSION 0, CREATE 1, MOD 2, VALUE 3, LEASE 4
    if (result !== 0) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: only EQUAL compares map to fero conditions (F8)')
    if (target === 3) return { key, if: { equals: s(c.value) } }
    const n = Number(target === 0 ? c.version : target === 1 ? c.create_revision : target === 2 ? c.mod_revision : -1)
    if (n === 0) return { key, if: { absent: true } }
    if (target === 2) return { key, if: { version: numVer(n) } }
    throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: VERSION, CREATE and LEASE compares other than 0 (F8)')
  }
  const txn = async (r: any) => {
    const cmps: { key: string; if: Record<string, any> }[] = (r.compare ?? []).map(cond)
    /** one branch: its writes as one batch (all or none) carrying `conds`, then its reads */
    const run = async (ops: any[], conds: typeof cmps): Promise<{ succeeded: boolean; responses: any[]; rev?: string }> => {
      const writes = ops.filter((o) => o.request_put || o.request_delete_range)
      const reads = ops.filter((o) => o.request_range)
      const ws = writes.map((o: any) => {
        const p = o.request_put, d = o.request_delete_range
        if (d && d.range_end && d.range_end.length > 0) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a DeleteRange over many keys (F8)')
        const key = s((p ?? d).key)
        return (p ? { key, value: s(p.value) } : { key, remove: true }) as Record<string, any>
      })
      if (new Set([...conds.map((c) => c.key), ...ws.map((w) => w.key)].map(partOf)).size > 1)
        throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a Txn across partitions (F8; saga() is the fero form)')
      let rev: string | undefined
      if (ws.length > 0) {
        for (const c of conds) {
          const w = ws.find((x) => x.key === c.key)
          if (!w) throw new Refuse(grpc.status.UNIMPLEMENTED, 'fero gateway: a compare on a key the Txn does not write (F8)')
          w.if = { ...(w.if ?? {}), ...c.if }
        }
        try { rev = (await env.run(() => kv.batch(ws)))[0]?.version } catch (e) { if (codeOf(e) === 'conflict') return { succeeded: false, responses: [] }; throw e }
      } else {
        // compares with no write: checked by linearizable reads, atomic with nothing (no write follows)
        for (const c of conds) {
          const got = await env.run(() => kv.get(c.key, { version: true, fresh: true })) as any
          const ok = c.if.absent ? !got : c.if.version ? got?.version === c.if.version : got?.value === c.if.equals
          if (!ok) return { succeeded: false, responses: [] }
        }
      }
      const out: any[] = writes.map((o) => (o.request_put ? { response_put: { header: header() } } : { response_delete_range: { header: header(), deleted: 1 } }))
      for (const o of reads) out.push({ response_range: await range(o.request_range) })
      return { succeeded: true, responses: out, rev }
    }
    stats.op(cmps.length > 0 ? 'txn-cas' : 'txn')
    let res = await run(r.success ?? [], cmps)
    if (!res.succeeded) {
      // the compares failed: the else-branch runs (reads, in practice) as its own step
      const other = await run(r.failure ?? [], [])
      res = { succeeded: false, responses: other.responses }
    }
    return { header: header(res.rev ? seen(verNum(res.rev)) : undefined), succeeded: res.succeeded, responses: res.responses }
  }

  // ── Lease ───────────────────────────────────────────────────────────────
  const grant = async (r: any) => {
    const id = String(r.ID && Number(r.ID) !== 0 ? r.ID : (0x6e000000 + ++leaseSeq))
    const ttl = Number(r.TTL)
    await env.run(() => leases.set(`lease/${id}`, { ttl }, { ttl: ttl * 1000 }))
    attached.set(id, { ttl, keys: new Set() })
    stats.op('lease-grant')
    return { header: header(), ID: id, TTL: ttl, error: '' }
  }
  const keepAlive = async (id: string) => {
    const L = attached.get(id)
    if (!L) return { header: header(), ID: id, TTL: 0 }
    await env.run(() => leases.touch(`lease/${id}`, { ttl: L.ttl * 1000 }))
    await Promise.all([...L.keys].map((k) => env.run(() => kv.touch(k, { ttl: L.ttl * 1000 })).catch(() => {})))
    stats.op('lease-keepalive')
    return { header: header(), ID: id, TTL: L.ttl }
  }
  const revoke = async (r: any) => {
    const id = String(r.ID)
    const L = attached.get(id)
    attached.delete(id)
    await env.run(() => leases.remove(`lease/${id}`))
    if (L) await Promise.all([...L.keys].map((k) => env.run(() => kv.remove(k)).catch(() => {})))
    stats.op('lease-revoke')
    return { header: header() }
  }

  // ── the gRPC server ─────────────────────────────────────────────────────
  const def = loader.loadSync(join(HERE, '..', 'proto', 'etcd-subset.proto'), { keepCase: true, longs: String, enums: Number, bytes: Buffer, defaults: true, oneofs: true })
  const pkg = grpc.loadPackageDefinition(def).etcdserverpb
  const unary = (fn: (r: any) => Promise<any>) => (call: any, cb: any) => {
    fn(call.request).then((x) => cb(null, x), (e: any) => {
      const c = e instanceof Refuse ? e.grpcCode : codeOf(e) === 'timeout' ? grpc.status.DEADLINE_EXCEEDED : grpc.status.UNKNOWN
      stats.err(e instanceof Refuse ? 'refused' : codeOf(e))
      cb({ code: c, details: String(e?.message ?? e) })
    })
  }
  const server = new grpc.Server({ 'grpc.max_concurrent_streams': 4096 })
  server.addService(pkg.KV.service, { Range: unary(range), Put: unary(put), DeleteRange: unary(del), Txn: unary(txn), Compact: unary(async () => ({ header: header() })) })
  server.addService(pkg.Lease.service, {
    LeaseGrant: unary(grant), LeaseRevoke: unary(revoke),
    LeaseTimeToLive: unary(async (r: any) => { const L = attached.get(String(r.ID)); return { header: header(), ID: r.ID, TTL: L ? L.ttl : -1, grantedTTL: L?.ttl ?? 0, keys: L ? [...L.keys].map((k) => Buffer.from(k, 'latin1')) : [] } }),
    LeaseKeepAlive: (call: any) => {
      call.on('data', (r: any) => { keepAlive(String(r.ID)).then((x) => call.write(x), (e) => { stats.err(codeOf(e)); call.write({ header: header(), ID: r.ID, TTL: 0 }) }) })
      call.on('end', () => call.end())
      call.on('error', () => {})
    },
  })
  server.addService(pkg.Watch.service, { Watch: (call: any) => { stats.err('watch-unimplemented'); call.emit('error', { code: grpc.status.UNIMPLEMENTED, details: 'fero gateway: Watch is not mapped (no PERF-07 row needs it)' }) } })
  server.addService(pkg.Cluster.service, { MemberList: unary(async () => ({ header: header(), members: [{ ID: MEMBER, name: 's1', peerURLs: [], clientURLs: [`http://${env.opts.listen ?? '127.0.0.1:12390'}`], isLearner: false }] })) })
  server.addService(pkg.Maintenance.service, { Status: unary(async () => ({ header: header(), version: '3.5.17', dbSize: 0, leader: MEMBER, raftIndex: rev, raftTerm: 1, raftAppliedIndex: rev, errors: [], dbSizeInUse: 0, isLearner: false })) })
  const listen = env.opts.listen ?? '127.0.0.1:12390'
  const port: number = await new Promise((res, rej) => server.bindAsync(listen, grpc.ServerCredentials.createInsecure(), (e: any, p: number) => (e ? rej(e) : res(p))))
  return { port, close: () => new Promise<void>((r) => server.tryShutdown(() => r())) }
}
