// lock — P-10, API.md §3 `lock(name, opts)`: a row in `#locks`, built only from the verbs.
//   acquire  set(name, { by }, { if: { expired: true }, ttl: lease })   absent or lapsed: re-created
//   token    the acquiring write's version (its born version; renewals keep it, API-NOTES C6)
//   renew    touch(name, { ttl: lease, if: { version } })               every lease/3 (C2's `if`)
//   release  remove(name, { if: { version } })
//   wait     a follow of the row wakes the next try; a timer gives up with 'locked'
// Every writer follows #locks, so `if: { fence }` on a protected write is refused 'fenced' once the
// writer has seen a newer token for that lock.

import { fero, FeroError } from '../../proto/index.ts'
import { dur, codeOf, watch } from './util.ts'

export interface LockOpts { lease?: number | string; wait?: number | string | 'forever'; renew?: boolean }
export interface Lock {
  readonly name: string
  readonly token: string
  readonly fence: { lock: string; token: string }
  readonly lost: Promise<void>
  renew(): Promise<void>
  release(): Promise<void>
}

export const lock = async (name: string, opts: LockOpts = {}): Promise<Lock> => {
  const lease = dur(opts.lease, 10_000)
  const locks = await fero('#locks')
  const deadline = opts.wait === 'forever' ? Infinity : fero.now() + dur(opts.wait, 0)
  const by = fero.id()
  let w: ReturnType<typeof watch> | null = null
  try {
    for (;;) {
      const sent = fero.now()
      try {
        const a = await locks.set(name, { by }, { if: { expired: true }, ttl: lease })
        return held(locks, name, a.version, lease, sent, opts.renew ?? true)
      } catch (e) { if (codeOf(e) !== 'conflict') throw e }
      const left = deadline - fero.now()
      if (left <= 0) throw new FeroError('locked', { resource: '#locks', key: [name] })
      w ??= watch(locks, [name])
      await w.next(Math.min(left, lease))      // the row changed (released, expired), or try again
    }
  } finally { w?.close() }
}

const held = (locks: any, name: string, token: string, lease: number, sent: number, renew: boolean): Lock => {
  let version = token, active = true
  let lostR!: () => void
  const lost = new Promise<void>((r) => { lostR = r })
  let timer: any = null, expiry: any = null
  const lose = (): void => { if (!active) return; active = false; clearTimeout(timer); clearTimeout(expiry); lostR() }
  // by this process's clock, the lease ends `lease` after the last write that set it was SENT
  const armExpiry = (from: number): void => { clearTimeout(expiry); expiry = setTimeout(lose, Math.max(1, from + lease - fero.now())); expiry.unref() }
  const doRenew = async (): Promise<void> => {
    const t = fero.now()
    const a = await locks.touch(name, { ttl: lease, if: { version } })
    version = a.version
    if (active) armExpiry(t)
  }
  const loop = (): void => {
    timer = setTimeout(async () => {
      if (!active) return
      try { await doRenew() } catch (e) { if (['conflict', 'absent-row'].includes(codeOf(e))) { lose(); return } }
      if (active) loop()
    }, lease / 3)
    timer.unref()                              // a renewal loop does not keep a process alive
  }
  armExpiry(sent)
  if (renew) loop()
  return {
    name, token, fence: { lock: name, token }, lost,
    renew: async () => { try { await doRenew() } catch (e) { lose(); throw e } },
    release: async () => {
      const v = version
      active = false; clearTimeout(timer); clearTimeout(expiry)
      try { await locks.remove(name, { if: { version: v } }) } catch (e) { if (codeOf(e) !== 'conflict') throw e }
    },
  }
}
