//! ── api/index — the composer: fero(name, opts) → { data, methods, cluster, destroy } ──
// The whole public surface (plan §9, the v2 shape kept): zero events, zero hooks —
// everything reactive is a ViewProxy you connect or tap. Config recognition is by
// VALUE TYPE backed by a DECLARED schema: function-valued opts are methods (any
// name — no reserved-verb discipline), non-function values must be known FeroConfig
// keys, typos throw at fero() time. Function-valued CONFIG lives under the one
// reserved `seams` key so the recognition rule survives.
//
// M5a scope: the server/solo composer over the shell Runtime — data binding both
// directions with the cid-overlay (api/data.ts), the default write methods with
// {confirm, timeout} against the M4c guarantee ladder, restore-before-network when
// `dir` holds a previous life, and a minimal reactive cluster surface. The client
// role (M5b) and user-method dispatch (M5c) land next.

import { randomUUID } from 'node:crypto'
import { Runtime, restoreOpts, type RuntimeOpts } from '../shell/runtime.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { Bind, type Coords } from './data.ts'
import { proxy } from './substrate.ts'
import type { Change, Fero, FeroOpts, Guarantee, Methods, WriteOpts, WriteReject, WriteResolve } from './types.ts'

//! the declared config schema: PICKED keys, everything else is a loud error (plan §9)
const CONFIG_KEYS = new Set(['uuid', 'listen', 'hosts', 'dir', 'heartbeatMs', 'redialMs', 'journalCap', 'seams'])
const SEAM_KEYS = new Set(['validation'])

//! keyPath — normalize the Change.key sugar: 'user42' and ['user42','active'] are both paths.
const keyPath = (k: string | string[] | undefined): string[] =>
  k === undefined ? [] : Array.isArray(k) ? k.map(String) : [String(k)]

export const fero = async (name: string, opts: FeroOpts = {}): Promise<Fero> => {
  //! split by value type: functions → methods; the rest must be declared config
  const userMethods: Record<string, (...args: unknown[]) => unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') userMethods[k] = v as (...args: unknown[]) => unknown
    else if (CONFIG_KEYS.has(k)) config[k] = v
    else throw new Error(`fero('${name}'): unknown option '${k}' — config keys are ${[...CONFIG_KEYS].join(', ')}; function values are methods`)
  }
  const seams = (config.seams ?? {}) as Record<string, unknown>
  for (const k of Object.keys(seams))
    if (!SEAM_KEYS.has(k)) throw new Error(`fero('${name}'): unknown seam '${k}' — M5a ships ${[...SEAM_KEYS].join(', ')}; hash/codec/storage land with their milestones`)

  const rtOpts: RuntimeOpts = {
    uuid: (config.uuid as string) ?? randomUUID().slice(0, 8),
    listen: config.listen as string | undefined,
    hosts: config.hosts as string[] | undefined,
    dir: config.dir as string | undefined,
    heartbeatMs: config.heartbeatMs as number | undefined,
    redialMs: config.redialMs as number | undefined,
    journalCap: config.journalCap as number | undefined,
    //! restore-before-network: a dir holding a previous life boots as its heir (incarnation bumped,
    // clock leased, votedFor honored) — the composer makes the wal.test.ts idiom the default path
    ...(config.dir ? restoreOpts(config.dir as string) : {}),
  }
  const rt = new Runtime(rtOpts)
  //! the binding wires rt.onApply BEFORE restore, so the WAL replay refills the proxy
  const bind = new Bind(rt, { validate: seams.validation as ((rec: Rec) => true | string) | undefined })
  if (config.dir) rt.restore()

  //! ── the confirm-probe multiplexer (M4c events under the methods surface) ──
  let probeSeq = 0
  const probes = new Map<number, (ok: boolean) => void>()
  rt.onConfirm = (id, ok) => { probes.get(id)?.(ok); probes.delete(id) }
  const probe = (c: Coords, level: number, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const id = ++probeSeq
      const t = setTimeout(() => {
        if (!probes.delete(id)) return
        rt.node.step({ kind: 'confirmCancel', id })
        resolve(false)
      }, ms)
      t.unref?.()
      probes.set(id, (ok) => { clearTimeout(t); resolve(ok) })
      rt.node.step({ kind: 'confirm', id, origin: c.origin, seq: c.seq, level })
    })

  //! ── the default write methods: the SAME ingest as assignment, plus await surfaces ──
  const write = async (rec: Rec, o: WriteOpts = {}): Promise<WriteResolve> => {
    const want: Guarantee = o.confirm ?? 'committed'
    const ms = o.timeout ?? 10_000
    const r = bind.issue([rec], false)[0]
    if (typeof r === 'string') throw { guarantee: want, reached: 'issued', reason: r } satisfies WriteReject
    const coords = await Promise.race([
      r,
      new Promise<never>((_, rej) => setTimeout(() => rej({ guarantee: want, reached: 'issued', reason: 'timeout' } satisfies WriteReject), ms).unref?.()),
    ])
    const resolved: WriteResolve = { guarantee: 'committed', key: rec.key.length ? rec.key : [String(rec.at ?? '')], origin: coords.origin, seq: coords.seq, epoch: coords.epoch, cid: coords.cid }
    if (want === 'committed') return resolved
    const ok = await probe(coords, want === 'persisted' ? CONFIRM.persisted : CONFIRM.replicated, ms)
    if (!ok) throw { guarantee: want, reached: 'committed', reason: 'timeout', localCommit: { origin: coords.origin, seq: coords.seq, epoch: coords.epoch } } satisfies WriteReject
    return { ...resolved, guarantee: want }
  }

  const methods = {
    update: (c: Change, o?: WriteOpts) => write({ type: REC.update, key: keyPath(c.key), value: c.value }, o),
    //! an insert without `at` mints its row key here (the substrate's proxy.insert mints too — the
    // wire needs the key BEFORE routing, so the api is the mint site for method-issued inserts)
    insert: (c: Change, o?: WriteOpts) => write({ type: REC.insert, key: keyPath(c.key), value: c.value, at: String(c.at ?? randomUUID()) }, o),
    remove: (c: Change, o?: WriteOpts) => write({ type: REC.remove, key: keyPath(c.key) }, o),
  } as Methods
  for (const [k, fn] of Object.entries(userMethods)) {
    if (k in methods) throw new Error(`fero('${name}'): method '${k}' overrides a default writer — that lands with M5c's dispatch`)
    methods[k] = () => { throw new Error(`fero('${name}').methods.${k}: user-method dispatch lands at M5c`) }
    void fn
  }

  //! ── cluster: a real ViewProxy over the committed view + peers + me (M5a minimal) ──
  // Folded from the journal cursor after any step that emitted membership-relevant events; one
  // integer compare per event otherwise. M5d makes this end-to-end (writes ring, partitions).
  const node = rt.node
  const cluster: any = proxy({
    epoch: node.epoch,
    writable: node.membership.gate(node).open,
    members: {},
    peers: {},
    me: { uuid: node.uuid, origin: node.uuid + '~' + node.incarnation, listen: (config.listen as string) ?? '' },
  })
  const FOLD = new Set<number>([JK.viewInstall, JK.evict, JK.gateOpen, JK.gateClose, JK.identified, JK.linkDown, JK.suspect, JK.start])
  let cursor = 0
  const fold = () => {
    const j = node.journal
    if (j.n === cursor) return
    const events = j.read(cursor)
    cursor = j.n
    if (!events.some((e) => FOLD.has(e.kind))) return
    cluster.epoch = node.epoch
    cluster.writable = node.membership.gate(node).open
    cluster.members = Object.fromEntries(node.membership.view.members)
    const peers: Record<string, { uuid: string; incarnation: number; up: boolean }> = {}
    for (const l of node.links.values())
      if (l.uuid && !l.dead) peers[l.uuid] = { uuid: l.uuid, incarnation: l.incarnation, up: true }
    cluster.peers = peers
  }
  rt.hook(fold)

  await rt.start()
  fold()

  return {
    name,
    data: bind.data,
    methods,
    cluster,
    async destroy() {
      bind.destroy()
      //! settle in-flight confirm probes honestly (false = could not prove in time) — never hang a caller
      for (const [, settle] of probes) settle(false)
      probes.clear()
      await rt.destroy()
    },
  }
}

export type { Fero, FeroOpts, Guarantee, WriteResolve, WriteReject, Change, WriteOpts, Methods } from './types.ts'
