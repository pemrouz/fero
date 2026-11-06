// common — what the pattern checks share. Importing it installs fero test's fake timers first
// (../timers.ts), as v4's battery is imported first.
import '../timers.ts'
import type { Ctx } from '../../proto/check.ts'
import type { Proc } from '../../proto/world.ts'
import { Feed } from '../../proto/l3.ts'

export { check, report, isMain, type Ctx } from '../../proto/check.ts'
export { fero, op, internals } from '../../proto/index.ts'
export { sleep } from '../timers.ts'

/** n server processes s1..sn: each marks itself a server, then runs `setup` (the library or the
 *  resource it serves: a resource nobody serves never commits, API-NOTES C1) */
export const servers = async (c: Ctx, n: number, setup: () => Promise<unknown> = async () => {}): Promise<Proc[]> => {
  const ps = c.procs(...Array.from({ length: n }, (_, i) => `s${i + 1}`))
  // the marker is a system name, so the fault schedule (which skips '#' names) lands on real resources
  for (const p of ps) await p.run(async () => { await p.fero('#app', { server: true }); await setup() })
  await c.settle()
  return ps
}
/** the code a promise rejects with ('ok' if it resolves) */
export const code = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); return 'ok' } catch (e: any) { return e?.code ?? String(e) } }
/** entries appended to a resource's logs so far (every group) */
export const appended = (c: Ctx, res: string): number => (c.stack.k.meta(res)?.groups ?? []).reduce((n: number, g: any) => n + g.last, 0)
/** the writer of a key's group, by process id */
export const writerOf = (c: Ctx, res: string, key: string): string | null => { const k = c.stack.k, m = k.meta(res)!; return k.groupOf(m, k.slotOf(k.partitionOf(m, key))).leader }
/** every committed entry of a resource, in order per partition across groups and slot moves (the
 *  feed L3 uses: a slot's entries in its new group wait for its old group's 'out'), for monitors */
export const committed = (c: Ctx, res: string): any[] => {
  const k = c.stack.k, m = k.meta(res)
  if (!m) return []
  const out: any[] = []
  new Feed(m).pull(k, m.groups.map((g: any) => g.commit), (e: any) => out.push(e))
  return out
}
