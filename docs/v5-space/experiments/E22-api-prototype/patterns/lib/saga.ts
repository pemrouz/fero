// saga — P-15, API.md §3 `saga(steps, { id, lease })`: "it takes locks in key order, writes an
// intent row, applies each step with a fence, then removes the intent". Built from the verbs, the
// lock library, and ids.ts (each step's write carries the attempt id `saga:<id>:<i>`, so a holder
// that re-sends, or a later holder that re-runs, applies a step at most once: API-NOTES D3).
//   the saga lock  `saga:<id>` in #locks: one runner at a time; its token fences every write
//   partition locks taken in key order, for isolation between sagas
//   the intent     #sagas row <id> = { steps, i, state }; written under the fence before any step,
//                  advanced after each; at the end its state is 'done' or 'undone' for a day (ttl), so a
//                  second call with the same id runs nothing
//   a refused step (a bound, a condition) undoes the steps done, in reverse, then throws its error
//   recovery       saga(anything, { id }) by any later process finds the intent and finishes or undoes it
//                  (it waits for the dead holder's saga lock to lapse)
// Readers may see the steps one at a time (P-15's SHOULD is not met: Q-A10).

import { fero, op, FeroError } from '../../proto/index.ts'
import { codeOf, dur } from './util.ts'
import { lock, type Lock } from './lock.ts'
import { withIds } from './ids.ts'

export interface Step { to: any; key: string | (string | number)[]; value?: unknown; remove?: true; if?: Record<string, unknown> }
interface StepRow { to: string; key: (string | number)[]; value?: unknown; remove?: true; if?: Record<string, unknown>; prev?: { had: boolean; value?: unknown } }
interface Intent { steps: StepRow[]; i: number; state: 'run' | 'undo' | 'done' | 'undone'; failed?: { code: string; reason?: string } }

const isOp = (v: unknown): v is { __op: string; spec: any } => v !== null && typeof v === 'object' && '__op' in (v as object)
const partOf = (res: any, key: (string | number)[]): string => `${res.name}:${String(key[0])}`

export const saga = async (steps: readonly Step[], opts: { id?: string; lease?: number | string } = {}): Promise<any[]> => {
  const id = opts.id ?? fero.id()
  const lease = dur(opts.lease, 10_000)
  const sagas = await fero('#sagas')
  const own = await lock(`saga:${id}`, { lease, wait: 3 * lease })      // a dead holder's lock lapses within one lease
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
    const handle = async (name: string, ids: () => string) => withIds(await fero(name), ids)
    const acks: any[] = []
    // run forward
    while (intent.state === 'run' && intent.i < intent.steps.length) {
      const s = intent.steps[intent.i]
      const w = await handle(s.to, () => `saga:${id}:${intent.i}`)
      const key = s.key.length === 1 ? s.key[0] : s.key
      try {
        acks.push(s.remove ? await w.remove(key, { if: { ...s.if, ...fence } }) : await w.set(key, s.value, { if: { ...s.if, ...fence } }))
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
          if (isOp(s.value) && s.value.__op === 'incr') await w.set(key, op.incr(-s.value.spec.n), { if: fence })
          else if (s.prev?.had) await w.set(key, s.prev.value, { if: fence })
          else await w.remove(key, { if: fence })
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
