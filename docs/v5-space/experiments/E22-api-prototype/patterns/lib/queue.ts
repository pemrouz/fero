// queue — P-09 and P-22, API.md §3 `queue(name, opts)`, built only from the verbs, on `claim`.
//   a message   a row `${partition}/${id}` = { job, at } in the resource `name` (partition before '/')
//   add         set(key, row, { if: { absent: true } }): a second add of the same id is a no-op
//   take        claim({ partition, n, lease, where: (row, t) => row.at <= t }): writer time decides
//   ack         remove(key, { if: { version: token } })    'conflict' if the lease lapsed and it was taken again
//   nack/extend touch(key, { lease, if: { version: token } }) (API-NOTES C2)
//   dead letter past `deliveries`, set in `${name}.dead` with if absent, then removed from the queue
//   priority    one sub-partition per level (`main!0` .. `main!9`; level 4 is `main` itself), taken in order (S)
//   delay/at    `at` is an absolute time; `delay` is anchored at the adder's clock (API-NOTES D5)
//   cron        the message is re-added at its next time in the same batch that acks it
//   waiting     a follow of the partitions wakes a take at an enqueue; a timer at the next due `at`;
//               a poll every second for leases that lapse (a lapse writes no record, so nothing wakes it)

import { fero, FeroError } from '../../proto/index.ts'
import { dur, codeOf, watch, cronNext } from './util.ts'

export interface QueueOpts { lease?: number | string; deliveries?: number; history?: number | string }
export interface AddOpts { partition?: string; id?: string; delay?: number | string; at?: number; cron?: string; priority?: number }
export interface TakeOpts { partitions?: readonly string[]; wait?: number | string; lease?: number | string }
export interface Msg<Job> {
  readonly id: string; readonly job: Job; readonly deliveries: number; readonly until: number
  ack(): Promise<void>; nack(opts?: { delay?: number | string }): Promise<void>; extend(lease?: number | string): Promise<void>
}
export interface Runner { readonly lag: number; stop(): Promise<void> }
export interface Queue<Job> {
  readonly name: string
  readonly dead: any
  add(job: Job, opts?: AddOpts): Promise<{ id: string }>
  take(n?: number, opts?: TakeOpts): Promise<Msg<Job>[]>
  work(fn: (job: Job, msg: Msg<Job>) => unknown, opts?: { concurrency?: number; partitions?: readonly string[] }): Runner
}

const POLL = 1000
const sub = (p: string, prio: number): string => (prio === 4 ? p : `${p}!${prio}`)
const idOf = (key: string): string => key.slice(key.indexOf('/') + 1).replace(/@\d+$/, '')

export const queue = async <Job = unknown>(name: string, opts: QueueOpts = {}): Promise<Queue<Job>> => {
  const q = await fero(name, { partition: { before: '/' }, ...(opts.history !== undefined ? { history: opts.history } : {}) })
  const dead = await fero(`${name}.dead`)
  const lease0 = dur(opts.lease, 30_000)
  const maxDeliveries = opts.deliveries ?? 5

  const add = async (job: Job, o: AddOpts = {}): Promise<{ id: string }> => {
    if (o.cron && o.id === undefined) throw new FeroError('config', { resource: name, reason: 'a cron message needs an id' })
    const id = o.id ?? fero.id()
    const at = o.at ?? (o.delay !== undefined ? fero.now() + dur(o.delay, 0) : o.cron ? cronNext(o.cron, fero.now()) : 0)
    const key = `${sub(o.partition ?? 'main', o.priority ?? 4)}/${id}${o.cron ? '@' + at : ''}`
    try { await q.set(key, { job, at, ...(o.cron ? { cron: o.cron } : {}) }, { if: { absent: true } }) }
    catch (e) { if (codeOf(e) !== 'conflict' || o.id === undefined) throw e }
    return { id }
  }

  /** the sub-partitions of p this process sees rows in, by priority (one claim each: S's cost) */
  const subsOf = (p: string): string[] => {
    const seen = new Set<string>()
    for (const k of Object.keys(q.snapshot)) { const part = k.slice(0, k.indexOf('/')); if (part === p || part.startsWith(p + '!')) seen.add(part) }
    const out: string[] = []
    for (let i = 0; i < 10; i++) if (seen.has(sub(p, i))) out.push(sub(p, i))
    return out.length > 0 ? out : [p]
  }
  /** the earliest future `at` among rows of these partitions, as this process holds them */
  const nextDue = (parts: readonly string[]): number => {
    let t = Infinity
    const now = fero.now()
    for (const [k, row] of Object.entries(q.snapshot as Record<string, any>)) {
      const part = k.slice(0, k.indexOf('/')).replace(/!\d$/, '')
      if (parts.includes(part) && row.at > now && row.at < t) t = row.at
    }
    return t
  }

  const toDead = async (c: any): Promise<void> => {
    try { await dead.set(idOf(c.key), { job: c.value.job, deliveries: c.deliveries - 1, key: c.key }, { if: { absent: true } }) }
    catch (e) { if (codeOf(e) !== 'conflict') throw e }
    try { await q.remove(c.key, { if: { version: c.token } }) } catch (e) { if (codeOf(e) !== 'conflict') throw e }
  }
  const msg = (c: any, lease: number): Msg<Job> => {
    let token = c.token
    return {
      id: idOf(c.key), job: c.value.job, deliveries: c.deliveries, until: c.until,
      ack: async () => {
        if (!c.value.cron) { await q.remove(c.key, { if: { version: token } }); return }
        // a cron message: the ack and the next occurrence are one write, in one partition
        const next = cronNext(c.value.cron, Math.max(fero.now(), c.value.at))
        const part = c.key.slice(0, c.key.indexOf('/'))
        await q.batch([{ key: c.key, remove: true, if: { version: token } }, { key: `${part}/${idOf(c.key)}@${next}`, value: { ...c.value, at: next }, if: { absent: true } }])
      },
      nack: async (o = {}) => { await q.touch(c.key, { lease: dur(o.delay, 0), if: { version: token } }) },
      extend: async (l) => { const a = await q.touch(c.key, { lease: dur(l, lease), if: { version: token } }); token = a.version },
    }
  }

  const takeOnce = async (parts: readonly string[], n: number, lease: number): Promise<Msg<Job>[]> => {
    const out: Msg<Job>[] = []
    for (const p of parts) for (const sp of subsOf(p)) {
      while (out.length < n) {
        const got = await q.claim({ partition: sp, n: n - out.length, lease, where: (row: any, t: number) => (row.at ?? 0) <= t })
        if (got.length === 0) break
        let live = 0
        for (const c of got) { if (c.deliveries > maxDeliveries) await toDead(c); else { out.push(msg(c, lease)); live++ } }
        if (live === got.length) break       // a dead-lettered message frees a place: claim again
      }
    }
    return out
  }

  const take = async (n = 1, o: TakeOpts = {}): Promise<Msg<Job>[]> => {
    const parts = o.partitions ?? ['main']
    const lease = dur(o.lease, lease0)
    const deadline = fero.now() + dur(o.wait, 0)
    let w: ReturnType<typeof watch> | null = null
    try {
      for (;;) {
        if (deadline > fero.now()) w ??= watch(q, parts.flatMap((p) => [p, ...[0, 1, 2, 3, 5, 6, 7, 8, 9].map((i) => sub(p, i))]))
        const got = await takeOnce(parts, n, lease)
        const left = deadline - fero.now()
        if (got.length > 0 || left <= 0) return got
        await w!.next(Math.min(left, nextDue(parts) - fero.now(), POLL))   // writes nothing while it waits
      }
    } finally { w?.close() }
  }

  const work = (fn: (job: Job, m: Msg<Job>) => unknown, o: { concurrency?: number; partitions?: readonly string[] } = {}): Runner => {
    let running = true
    const loop = (async () => {
      while (running) {
        const ms = await take(o.concurrency ?? 1, { partitions: o.partitions, wait: '5s' })
        await Promise.all(ms.map(async (m) => {
          try { await fn(m.job, m) } catch { await m.nack().catch(() => {}); return }
          await m.ack().catch(() => {})       // 'conflict': the lease lapsed and another worker has it
        }))
      }
    })()
    return { lag: 0, stop: async () => { running = false; await loop } }
  }

  return { name, dead, add, take, work }
}
