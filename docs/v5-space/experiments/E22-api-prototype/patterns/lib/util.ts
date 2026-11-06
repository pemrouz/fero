// util — small helpers the L5 libraries share. Built only from the verbs: a watcher is a follow
// whose tap says "something changed in these partitions". Timers are plain setTimeout (under a
// world, fero test's fake timers make them virtual: ../timers.ts).

import { FeroError } from '../../proto/index.ts'

const UNIT: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }
/** a Duration (API.md: a number is ms, or '30s', '10m', ...) as ms */
export const dur = (d: number | string | undefined, def: number): number => {
  if (d === undefined) return def
  if (typeof d === 'number') return d
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d)
  if (!m) throw new FeroError('config', { reason: `'${d}' is not a duration` })
  return Number(m[1]) * UNIT[m[2]]
}

export const codeOf = (e: unknown): string => (e as FeroError)?.code ?? String(e)

/** Watch some partitions of a resource: next(ms) resolves at the first change since the last
 *  call, or after ms. The follow is opened BEFORE the caller's next try, so no change is missed. */
export const watch = (res: any, partitions: string[]): { next(ms: number): Promise<void>; close(): void } => {
  let first = true, dirty = false
  let wake: (() => void) | null = null
  const f = res.follow(partitions)
  f.tap(() => { if (first) { first = false; return } dirty = true; wake?.() })   // data's tap fires once on registration
  return {
    next: (ms) => {
      if (dirty) { dirty = false; return Promise.resolve() }
      return new Promise<void>((r) => {
        const t = setTimeout(() => { wake = null; r() }, Math.max(1, ms))
        wake = () => { wake = null; dirty = false; clearTimeout(t); r() }
      })
    },
    close: () => { wake?.(); f.close() },
  }
}

/** the next time (UTC ms) a five-field cron rule fires after `after` (minute hour dom month dow;
 *  `*`, numbers, lists, ranges and steps). Enough for P-22; not a full cron. */
export const cronNext = (rule: string, after: number): number => {
  const f = rule.trim().split(/\s+/)
  if (f.length !== 5) throw new FeroError('config', { reason: `cron '${rule}' needs five fields` })
  const set = (s: string, lo: number, hi: number): Set<number> => {
    const out = new Set<number>()
    for (const part of s.split(',')) {
      const [r, st] = part.split('/')
      const step = st ? Number(st) : 1
      const [a, b] = r === '*' ? [lo, hi] : r.includes('-') ? r.split('-').map(Number) : [Number(r), st ? hi : Number(r)]
      for (let x = a; x <= b; x += step) out.add(x)
    }
    return out
  }
  const [mi, ho, dm, mo, dw] = [set(f[0], 0, 59), set(f[1], 0, 23), set(f[2], 1, 31), set(f[3], 1, 12), set(f[4], 0, 6)]
  let t = Math.floor(after / 60_000) * 60_000 + 60_000
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60_000) {
    const d = new Date(t)
    if (mi.has(d.getUTCMinutes()) && ho.has(d.getUTCHours()) && dm.has(d.getUTCDate()) && mo.has(d.getUTCMonth() + 1) && dw.has(d.getUTCDay())) return t
  }
  throw new FeroError('config', { reason: `cron '${rule}' never fires` })
}
