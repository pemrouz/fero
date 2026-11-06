// small — the short L5 libraries: limiter (P-11), service (P-21), migrate (P-20), tape (P-18).
// Built only from the verbs (migrate also uses ids.ts: API-NOTES D3).

import { fero, op, FeroError } from '../../proto/index.ts'
import { dur, codeOf, watch } from './util.ts'
import { withIds } from './ids.ts'

// ── limiter: a fixed window per key, one bounded incr per take ─────────────────────────────────
// The window is the caller's clock's (a client cannot read writer time before it writes: D5);
// the row lives two windows. A refused take is a refused write: nothing is appended (P-11).
export const limiter = async (name: string, opts: { max: number; per: number | string }) => {
  const r = await fero<number>(name)
  const per = dur(opts.per, 60_000)
  return {
    take: async (key: string, n = 1): Promise<{ left: number; reset: number }> => {
      const w = Math.floor(fero.now() / per)
      const reset = (w + 1) * per
      try {
        const a = await r.set(`${key}@${w}`, op.incr(n, { max: opts.max }), { ttl: 2 * per })
        return { left: opts.max - (a.value as number), reset }
      } catch (e) {
        if (codeOf(e) === 'conflict') throw new FeroError('limited', { resource: name, key: [key], retryAfter: Math.max(0, reset - fero.now()) })
        throw e
      }
    },
  }
}

// ── service: request and reply on claim, presence and conditions ──────────────────────────────
//   answerers   rows `<group>~ans/<id>` bound to the answerer's session (presence)
//   a request   a row `<group>~req/<id>` = { req, from, reply }, ttl = the ask's timeout; answerers claim them
//   the reply   a row `r~<asker>/<id>`, written if: { absent: true }: at most one answer per request
// API.md says the service resource is durability 'none' by default; it cannot be: 'none' needs
// rows: false, and claim needs rows (API-NOTES D7). So it is persisted.
export const service = async <Req = unknown, Res = unknown>(name: string, _opts: { durability?: 'none' | 'persisted' } = {}) => {
  const s = await fero(`svc.${name}`, { partition: { before: '/' } })
  const me = fero.id()
  return {
    answer: (fn: (req: Req, info: { from: string }) => Res | Promise<Res>, o: { group?: string; concurrency?: number } = {}) => {
      const g = o.group ?? 'main'
      let running = true
      const loop = (async () => {
        await s.set(`${g}~ans/${me}`, { at: fero.now() }, { while: 'session' })
        const w = watch(s, [`${g}~req`])
        while (running) {
          const got = await s.claim({ partition: `${g}~req`, n: o.concurrency ?? 1, lease: '10s' })
          if (got.length === 0) { await w.next(1000); continue }
          await Promise.all(got.map(async (c: any) => {
            let res: Res
            try { res = await fn(c.value.req, { from: c.value.from }) } catch (e) { res = { error: String((e as Error)?.message ?? e) } as Res }
            try { await s.set(c.value.reply, { res }, { if: { absent: true } }) } catch (e) { if (codeOf(e) !== 'conflict') return }
            await s.remove(c.key, { if: { version: c.token } }).catch(() => {})
          }))
        }
        w.close()
      })()
      return { lag: 0, stop: async () => { running = false; await s.remove(`${g}~ans/${me}`).catch(() => {}); await loop } }
    },
    ask: async (req: Req, o: { timeout?: number | string; group?: string } = {}): Promise<Res> => {
      const g = o.group ?? 'main'
      const timeout = dur(o.timeout, 10_000)
      // no live answerer, as this process sees presence: refused at once
      if (!Object.keys(s.snapshot).some((k) => k.startsWith(`${g}~ans/`))) throw new FeroError('no-answerer', { resource: name })
      const id = fero.id()
      const replyPart = `r~${me}`, reply = `${replyPart}/${id}`
      const deadline = fero.now() + timeout
      const w = watch(s, [replyPart])
      try {
        await s.set(`${g}~req/${id}`, { req, from: me, reply }, { ttl: timeout })
        for (;;) {
          const row = s.snapshot[reply]
          if (row !== undefined) { s.remove(reply).catch(() => {}); return row.res as Res }
          const left = deadline - fero.now()
          if (left <= 0) throw new FeroError('timeout', { resource: name, reason: 'no answer in time' })
          await w.next(left)
        }
      } finally { w.close() }
    },
  }
}

// ── migrate: rewrite every live row at the new shape, resumable, exactly once, paced ─────────────
// Progress is a #migrate row; each rewrite carries the attempt id `mig:<res>@<to>:<key>` and the
// row's version as a condition (a concurrent write wins). A re-run after a crash meets its own
// earlier rewrite as 'call-diverged' (the same id, a different body), which means "done".
export const migrate = async <A, B>(res: any, opts: { to: number; fn: (row: A) => B; perSec?: number }) => {
  const jobs = await fero('#migrate')
  const job = `${res.name}@${opts.to}`
  const keys = Object.keys(res.snapshot).sort()            // a server: it holds every row
  const start = ((await jobs.get(job, { fresh: true })) as any)?.done ?? ''
  let rows = keys.filter((k) => k <= start).length, paused = false
  let resumeR: (() => void) | null = null
  const gap = opts.perSec ? 1000 / opts.perSec : 0
  const done = (async () => {
    for (const k of keys) {
      if (k <= start) continue
      while (paused) await new Promise<void>((r) => { resumeR = r })
      const got = await res.get(k, { version: true })
      if (got) {
        const w = withIds<any>(res, () => `mig:${job}:${k}`)
        try { await w.set(k, opts.fn(got.value), { if: { version: got.version } }) }
        catch (e) { if (!['conflict', 'call-diverged'].includes(codeOf(e))) throw e }
      }
      rows++
      if (rows % 10 === 0 || rows === keys.length) await jobs.set(job, { done: k, rows })
      if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    }
    await jobs.set(job, { done: '￿', rows })
  })()
  return { done, progress: () => ({ rows, of: keys.length }), pause: () => { paused = true }, resume: () => { paused = false; resumeR?.() } }
}

// ── tape: inputs and answers by match key, for a window ─────────────────────────────────────
// Every recording of one tape is a row of ONE partition (`rec/<match>`): a replay needs an order
// across recordings, and fero orders only within a partition (TEST-12's shuffle broke a tape keyed
// one row per match: API-NOTES D15). So one tape has one writer.
export const tape = async <In = unknown, Out = unknown>(name: string, opts: { window?: number | string } = {}) => {
  const window = opts.window ?? '14d'
  const t = await fero(`tape.${name}`, { partition: { before: '/' }, history: window, rows: { ttl: window } })
  return {
    record: async (match: string, input: In, answer: Out): Promise<void> => { await t.set(`rec/${match}`, { input, answer }) },
    find: (match: string): Out | undefined => (t.snapshot[`rec/${match}`] as any)?.answer,
    replay: (from?: string): AsyncIterable<{ match: string; input: In; answer: Out; version: string }> => ({
      [Symbol.asyncIterator]: () => {
        const it = t.read({ from: from ?? 'earliest' })[Symbol.asyncIterator]()
        return {
          next: async (): Promise<IteratorResult<any>> => {
            for (;;) {
              const r = await it.next()
              if (r.done) return r
              if (r.value.row) return { value: { match: String(r.value.rec.key[0]).slice(4), input: r.value.row.input, answer: r.value.row.answer, version: r.value.version }, done: false }
            }
          },
          return: async () => { await it.return?.(); return { value: undefined, done: true } },
        }
      },
    }),
  }
}
