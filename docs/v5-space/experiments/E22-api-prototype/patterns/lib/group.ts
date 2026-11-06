// group — P-08 and P-17, API.md §3 `group(source, name)` and `derive(...)`, built only from the
// verbs (plus ids.ts for run()'s outputs: API-NOTES D3).
//   shares      SHARES fixed shares of the source (`read({ share: { index, of } })`): a partition is
//               in one share forever
//   ownership   one #locks row per share, `grp:<source>:<group>:<i>`, taken with if expired + ttl
//               lease, renewed with touch(if version); its version is the share's fence token
//   cursor      one #groups row per share, `cur:<source>:<group>:<i>` = { c }, always written with
//               if: { fence } — a new owner first rewrites it under its own token, so from then on
//               a paused (zombie) owner's commit is refused 'fenced' by that row's own writer
//   members     #groups rows `mem:<source>:<group>:<member>`, bound to the member's session; each
//               member aims at ceil(SHARES / members) shares, gives back extras between batches,
//               takes free ones
//   run(fn)     each entry's outputs carry attempt ids made from (source partition, version, n):
//               a re-run after a crash is answered by dedup (effectively once); the cursor commits
//               after them

import { fero, FeroError } from '../../proto/index.ts'
import { dur, codeOf } from './util.ts'
import { withIds } from './ids.ts'

export const SHARES = 16
export interface GroupOpts { from?: 'earliest' | 'latest'; lease?: number | string; max?: number }
export interface Out { use<R2 = any>(target: any): any }
export interface GroupBatch<Row> { readonly entries: any[]; commit(): Promise<void> }
export interface Runner { readonly lag: number; stop(): Promise<void> }
export interface Group<Row> extends AsyncIterable<GroupBatch<Row>> {
  readonly member: string; readonly generation: number; readonly owned: number
  run(fn: (e: any, out: Out) => unknown): Runner
  leave(): Promise<void>
}
interface Share { i: number; token: string; version: string; reader: any; it: AsyncIterator<any>; pending: Promise<void> | null; buf: { e: any; cursor: string; j: number }[]; uncommitted: number; last: { at: string; j: number } | null }

export const group = async <Row = any>(source: any, name: string, opts: GroupOpts = {}): Promise<Group<Row>> => {
  const locks = await fero('#locks')
  const meta = await fero('#groups')
  const lease = dur(opts.lease, 10_000), max = opts.max ?? 100, from = opts.from ?? 'earliest'
  const member = fero.id()
  const base = `${source.name}:${name}`
  const lockOf = (i: number): string => `grp:${base}:${i}`
  const curOf = (i: number): string => `cur:${base}:${i}`
  await meta.set(`mem:${base}:${member}`, { at: fero.now() }, { while: 'session' })
  const owned = new Map<number, Share>()
  let generation = 0, stopped = false, timer: any = null
  let wakeR: (() => void) | null = null
  const recIndex = new WeakMap<object, number>()

  const drop = (i: number): void => { const s = owned.get(i); if (!s) return; owned.delete(i); s.reader.close() }
  const tryTake = async (i: number): Promise<void> => {
    let token: string
    try { token = (await locks.set(lockOf(i), { member }, { if: { expired: true }, ttl: lease })).version } catch (e) { if (codeOf(e) === 'conflict') return; throw e }
    // fence the cursor row with this token first: a zombie's later commit is then refused there
    let c: string | null = null
    for (;;) {
      const got = await meta.get(curOf(i), { fresh: true, version: true })
      c = got?.value.c ?? null
      try { await meta.set(curOf(i), { c, by: member }, { if: { fence: { lock: lockOf(i), token }, ...(got ? { version: got.version } : { absent: true }) } }); break }
      catch (e) { if (codeOf(e) === 'conflict') continue; if (codeOf(e) === 'fenced') return; throw e }
    }
    const reader = source.read({ from: c ?? from, share: { index: i, of: SHARES } })
    owned.set(i, { i, token, version: token, reader, it: reader[Symbol.asyncIterator](), pending: null, buf: [], uncommitted: 0, last: null })
    generation++
  }
  const release = async (i: number): Promise<void> => {
    const s = owned.get(i)!
    drop(i)
    try { await locks.remove(lockOf(i), { if: { version: s.version } }) } catch (e) { if (codeOf(e) !== 'conflict') throw e }
  }
  const rebalance = async (): Promise<void> => {
    for (const [i, s] of [...owned]) {
      try { s.version = (await locks.touch(lockOf(i), { ttl: lease, if: { version: s.version } })).version }
      catch (e) { if (['conflict', 'absent-row'].includes(codeOf(e))) drop(i) }   // lost it: a newer owner has it
    }
    if (stopped) return
    const members = Object.keys(meta.snapshot).filter((k) => k.startsWith(`mem:${base}:`)).length
    const target = Math.ceil(SHARES / Math.max(1, members))
    for (const [i, s] of [...owned].reverse()) if (owned.size > target && s.uncommitted === 0 && s.buf.length === 0) await release(i)
    for (let i = 0; i < SHARES && owned.size < target; i++) if (!owned.has(i) && locks.snapshot[lockOf(i)] === undefined) await tryTake(i)
  }
  const tick = (): void => {
    timer = setTimeout(async () => { if (stopped) return; await rebalance().catch(() => {}); wakeR?.(); tick() }, lease / 3)
    timer.unref()                                        // membership work does not keep a process alive
  }
  await rebalance()
  tick()

  const nextBatch = async (): Promise<GroupBatch<Row> | null> => {
    for (;;) {
      if (stopped) return null
      const entries: any[] = []
      const upTo = new Map<number, string>()
      for (const s of owned.values()) while (s.buf.length > 0 && entries.length < max) { const x = s.buf.shift()!; entries.push(x.e); recIndex.set(x.e, x.j); upTo.set(s.i, x.cursor); s.uncommitted++ }
      if (entries.length > 0) return batchOf(entries, upTo)
      // the records of one entry (a batch write) share its version and arrive one after another in
      // their share: j numbers them, so each record keeps its own output ids however often it is read
      const got = (s: Share, e: any): void => {
        const at = `${e.partition}:${e.version}`
        const j = s.last && s.last.at === at ? s.last.j + 1 : 0
        s.last = { at, j }
        s.buf.push({ e, cursor: s.reader.cursor, j })
      }
      const waits = [...owned.values()].map((s) => (s.pending ??= s.it.next().then((r) => { s.pending = null; if (!r.done) got(s, r.value) }, () => { s.pending = null; drop(s.i) })))
      await Promise.race([...waits, new Promise<void>((r) => { wakeR = r })])
      wakeR = null
    }
  }
  const batchOf = (entries: any[], upTo: Map<number, string>): GroupBatch<Row> => ({
    entries,
    commit: async () => {
      for (const [i, c] of upTo) {
        const s = owned.get(i)
        if (!s) throw new FeroError('fenced', { resource: '#groups', key: [curOf(i)], reason: 'this member no longer owns the share' })
        try { await meta.set(curOf(i), { c, by: member }, { if: { fence: { lock: lockOf(i), token: s.token } } }); s.uncommitted = 0 }
        catch (e) { if (codeOf(e) === 'fenced') drop(i); throw e }
      }
    },
  })
  const leave = async (): Promise<void> => {
    stopped = true; clearTimeout(timer); wakeR?.()
    for (const i of [...owned.keys()]) await release(i)
    await meta.remove(`mem:${base}:${member}`).catch(() => {})
  }

  return {
    member,
    get generation() { return generation },
    get owned() { return owned.size },
    [Symbol.asyncIterator]: () => ({
      next: async () => { const b = await nextBatch(); return b ? { value: b, done: false } : { value: undefined as any, done: true } },
      return: async () => { await leave(); return { value: undefined as any, done: true } },
    }),
    run: (fn) => {
      const loop = (async () => {
        for (;;) {
          const b = await nextBatch()
          if (!b) return
          for (const e of b.entries) {
            let n = 0
            const id = `run:${base}:${e.partition}:${e.version}.${recIndex.get(e) ?? 0}`
            await fn(e, { use: (t: any) => withIds(t, () => `${id}#${n++}`) })
          }
          await b.commit().catch((e) => { if (codeOf(e) !== 'fenced') throw e })
        }
      })()
      return { lag: 0, stop: async () => { await leave(); await loop.catch(() => {}) } }
    },
    leave,
  }
}

export const derive = async <A, B>(source: any, target: any, fn: (e: any, out: any) => unknown, opts: { name?: string; from?: 'earliest' | 'latest' } = {}): Promise<Runner> => {
  const g = await group<A>(source, opts.name ?? `derive:${target.name}`, { from: opts.from })
  return g.run((e, out) => fn(e, out.use(target)))
}
