// saga-owned — E-22 step 3: step 2's saga (../patterns/lib/saga.ts), copied, plus two rules, to test
// whether it removes the write cycles (G0) Elle found between units when a holder dies mid-saga.
//
// What Elle found: unit A's holder dies after A's first step; A's partition locks lapse with its
// lease; unit B takes them and writes the same rows; a recoverer finishes A later. On one row A's
// write is before B's, on another after: a write cycle between units (G0), which P-15's MUST forbids.
//
// The rules (Percolator's: a lock left by a dead client is resolved before anyone takes it over):
//  1. After a saga holds all its partition locks it marks its intent `locked` (before any step), and
//     each step is written under the fence of its partition's lock, not only the saga's own lock: a
//     holder that lost a partition lock can no longer write there.
//  2. After taking its partition locks, a saga looks for another saga's unfinished intent that is
//     `locked` and touches one of its partitions: that saga lost a lock it held while it may have
//     written. It releases its own partition locks, takes that saga's lock (waiting for it to lapse
//     if its holder is paused), finishes or undoes that saga, and starts over. An unfinished saga that
//     is not `locked` has written nothing and waits for the locks like any other.
// Everything else is step 2's code. The changes are marked "owned:".

import { fero, op, FeroError } from '../proto/index.ts'
import { codeOf, dur } from '../patterns/lib/util.ts'
import { lock, type Lock } from '../patterns/lib/lock.ts'
import { withIds } from '../patterns/lib/ids.ts'

export interface Step { to: any; key: string | (string | number)[]; value?: unknown; remove?: true; if?: Record<string, unknown> }
interface StepRow { to: string; key: (string | number)[]; value?: unknown; remove?: true; if?: Record<string, unknown>; prev?: { had: boolean; value?: unknown } }
interface Intent { steps: StepRow[]; i: number; state: 'run' | 'undo' | 'done' | 'undone'; failed?: { code: string; reason?: string }; locked?: boolean }

const isOp = (v: unknown): v is { __op: string; spec: any } => v !== null && typeof v === 'object' && '__op' in (v as object)
const partOf = (res: any, key: (string | number)[]): string => `${res.name}:${String(key[0])}`

export const sagaOwned = async (steps: readonly Step[], opts: { id?: string; lease?: number | string; wait?: number } = {}): Promise<any[]> => {
  const id = opts.id ?? fero.id()
  const lease = dur(opts.lease, 10_000)
  const sagas = await fero('#sagas')
  const own = await lock(`saga:${id}`, { lease, wait: opts.wait ?? 3 * lease })      // a dead holder's lock lapses within one lease
  const fence = { fence: own.fence }
  const held: Lock[] = []
  try {
    const got = await sagas.get(id, { fresh: true, version: true })
    let intent: Intent
    if (got?.value.state === 'done') return []                             // ran before, under this id: once only
    if (got?.value.state === 'undone') throw new FeroError((got.value.failed?.code ?? 'conflict') as any, { resource: '#sagas', key: [id], reason: 'saga undone' })
    if (got) intent = got.value as Intent                                  // a holder died: finish or undo its saga
    else {
      intent = { steps: steps.map((s) => ({ to: s.to.name, key: Array.isArray(s.key) ? [...s.key] : [s.key], value: s.value, remove: s.remove, if: s.if })), i: 0, state: 'run' }
      // what a plain set or remove replaces, so it can be undone (an op is undone by its inverse)
      for (const s of intent.steps) if (!isOp(s.value)) {
        const res = await fero(s.to)
        const cur = await res.get(s.key.length === 1 ? s.key[0] : s.key, { fresh: true })
        s.prev = cur === undefined ? { had: false } : { had: true, value: cur }
      }
      await sagas.set(id, intent, { if: { absent: true, ...fence } })
    }
    // partition locks, in key order
    const parts = [...new Set(intent.steps.map((s) => `${s.to}:${String(s.key[0])}`))].sort()
    for (const p of parts) held.push(await lock(`saga-p:${p}`, { lease, wait: 3 * lease }))
    // owned (rule 2): resolve an unfinished, locked saga that touches my partitions before writing
    const partLock = new Map<string, Lock>()
    for (let round = 0; ; round++) {
      const mine = new Set(parts)
      const blocker = Object.entries(sagas.snapshot as Record<string, Intent & { locked?: boolean }>).find(([sid, v]) =>
        sid !== id && v.locked === true && (v.state === 'run' || v.state === 'undo') && v.steps.some((s) => mine.has(`${s.to}:${String(s.key[0])}`)))
      if (!blocker) break
      if (round >= 30) throw new FeroError('locked', { resource: '#sagas', key: [blocker[0]], reason: 'an unfinished saga holds these partitions' })
      for (const l of held.splice(0).reverse()) await l.release().catch(() => {})
      try { const l = await lock(`saga:${blocker[0]}`, { lease, wait: 3 * lease }); await l.release() } catch (e) { if (codeOf(e) !== 'locked') throw e }
      await sagaOwned([], { id: blocker[0], lease }).catch(() => {})   // finish or undo it (a no-op if its holder just did)
      for (const p of parts) held.push(await lock(`saga-p:${p}`, { lease, wait: 3 * lease }))
    }
    parts.forEach((p, i) => partLock.set(p, held[i]))
    // owned (rule 1): mark the intent locked before any step
    if (!(intent as any).locked) { intent = { ...intent, locked: true } as Intent; await sagas.set(id, intent, { if: fence }) }
    const pfence = (s: StepRow) => ({ fence: partLock.get(`${s.to}:${String(s.key[0])}`)!.fence })
    const handle = async (name: string, ids: () => string) => withIds(await fero(name), ids)
    const acks: any[] = []
    // run forward
    while (intent.state === 'run' && intent.i < intent.steps.length) {
      const s = intent.steps[intent.i]
      const w = await handle(s.to, () => `saga:${id}:${intent.i}`)
      const key = s.key.length === 1 ? s.key[0] : s.key
      try {
        acks.push(s.remove ? await w.remove(key, { if: { ...s.if, ...pfence(s) } }) : await w.set(key, s.value, { if: { ...s.if, ...pfence(s) } }))
        intent = { ...intent, i: intent.i + 1 }
      } catch (e) {
        if (codeOf(e) === 'fenced' || codeOf(e) === 'timeout') throw e      // not ours any more, or unknown: a later holder decides
        // 'call-diverged': this step's attempt id already committed (an earlier holder applied it under
        // its own fence token, so the body differs): the step is done (API-NOTES D14)
        if (codeOf(e) === 'call-diverged') { acks.push(undefined); intent = { ...intent, i: intent.i + 1 } }
        else intent = { ...intent, state: 'undo', failed: { code: codeOf(e), reason: (e as FeroError).reason } }
      }
      await sagas.set(id, intent, { if: fence })
    }
    // undo, in reverse: an op by its inverse, a set or remove by what it replaced
    if (intent.state === 'undo') {
      for (let j = intent.i - 1; j >= 0; j--) {
        const s = intent.steps[j]
        const w = await handle(s.to, () => `saga:${id}:undo:${j}`)
        const key = s.key.length === 1 ? s.key[0] : s.key
        try {
          if (isOp(s.value) && s.value.__op === 'incr') await w.set(key, op.incr(-s.value.spec.n), { if: pfence(s) })
          else if (s.prev?.had) await w.set(key, s.prev.value, { if: pfence(s) })
          else await w.remove(key, { if: pfence(s) })
        } catch (e) { if (codeOf(e) !== 'call-diverged') throw e }         // undone already by an earlier holder
        intent = { ...intent, i: j }
        await sagas.set(id, intent, { if: fence })
      }
    }
    // the outcome stays a day, so a later call with this id does not run it again (as a call key)
    await sagas.set(id, { ...intent, state: intent.state === 'undo' ? 'undone' : 'done' }, { if: fence, ttl: '1d' })
    if (intent.state === 'undo') throw new FeroError((intent.failed?.code ?? 'conflict') as any, { resource: '#sagas', key: [id], reason: `saga undone: ${intent.failed?.reason ?? ''}` })
    return acks
  } finally {
    for (const l of held.reverse()) await l.release().catch(() => {})
    await own.release().catch(() => {})
  }
}
