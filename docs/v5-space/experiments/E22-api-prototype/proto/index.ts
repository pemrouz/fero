// index — what an app imports: `import { fero, op } from '<proto>/index.ts'`, the names API.md §3
// declares. Under a world (fero.world), every fero() resolves in the simulated process the caller
// runs as (proc.run, or proc.fero); outside one, the first fero() makes an implicit world.
// The L5 libraries (queue, lock, group, derive, saga, limiter, service, migrate, tape, gateway) are
// not part of step 1: they are built from the verbs here, in E-22's later steps.

import { World, Proc, theWorld, type WorldOpts, type FaultStep } from './world.ts'
import { openResource, feroFor, op, stackOf, sysRes, type Op } from './api.ts'
import { FeroError, type Code } from './errors.ts'
import { fnv1a, ms } from './util.ts'
import { upcastHeld } from './l2.ts'

World.api = feroFor

type Opts = Record<string, any>

/** fero(name, opts): a resource handle in the calling process (API.md §3) */
export const fero: {
  <Row = any>(name: string, opts?: Opts): Promise<any>
  id(): string
  now(): number
  alter(name: string, change: Opts): Promise<void>
  drop(name: string): Promise<void>
  fork(name: string, opts: { as: string; at?: string }): Promise<void>
  token(claims: Record<string, unknown>, opts?: { ttl?: number | string }): string
  revoke(sub: string): Promise<void>
  clientKey(secret: string): string
  spawn(file: string, args?: string[], opts?: unknown): never
  world(opts?: WorldOpts): World
} = Object.assign(
  (name: string, opts?: Opts) => {
    const w = theWorld()
    const P = w.current()
    return openResource(P, name, opts)
  },
  {
    id: (): string => theWorld().id(),
    now: (): number => { const w = theWorld(); return w.current().clock() },
    alter: async (name: string, change: Opts): Promise<void> => {
      const s = stackOf(theWorld())
      const meta = s.k.meta(name)
      if (!meta) throw new FeroError('config', { resource: name, reason: 'no such resource' })
      if ('gate' in change) { meta.gate = change.gate; return }
      for (const [k, v] of Object.entries(change)) {
        if (k === 'shape') {
          // the catalog records from which position each shape.version is in force (P-20); the rows
          // every fold already holds pass the upcasters now, so live equals a rebuild from the log
          const from = meta.opts.shape?.version ?? 1
          meta.opts.shape = { ...(meta.opts.shape ?? {}), version: v.version }
          if (v.up) meta.code.up = v.up
          meta.groups.forEach((g, n) => meta.shapes[n].push([g.last + 1, v.version]))
          const up = meta.code.up
          if (up && v.version > from) {
            for (const wr of s.l2.writers.values()) if (wr.meta === meta) upcastHeld(wr.rows, up, from, v.version, () => {})
            for (const p of meta.folders) { const r = s.l3.replicaIf(p, name); if (r) upcastHeld(r.src, up, from, v.version, (e) => s.l3.fault(p, e)) }
          }
        } else meta.opts[k] = v
      }
    },
    drop: async (name: string): Promise<void> => { stackOf(theWorld()).k.drop(name) },
    fork: async (): Promise<void> => { throw new FeroError('config', { message: 'fork is not built in the E-22 prototype (step 1); see API-NOTES' }) },
    token: (claims: Record<string, unknown>, opts?: { ttl?: number | string }): string => {
      const body = { ...claims, exp: claims.exp ?? theWorld().time + ms(opts?.ttl, 3_600_000) }
      return 'tok.' + Buffer.from(JSON.stringify(body)).toString('base64url')
    },
    revoke: async (): Promise<void> => {},
    clientKey: (secret: string): string => 'ck.' + fnv1a('client:' + secret).toString(36),
    spawn: (): never => { throw new FeroError('config', { message: 'fero.spawn has no meaning inside one simulated OS process; use world.proc(id)' }) },
    world: (opts?: WorldOpts): World => new World(opts),
  },
)

export { op, FeroError, World, Proc }
export type { Op, Code, WorldOpts, FaultStep }

/** internals for checks (not the app's API): the kernel, L2, L3 of a world */
export const internals = {
  stack: (w: World) => stackOf(w),
  sys: (w: World, p: Proc, name: string) => sysRes(stackOf(w), p, name),
}
