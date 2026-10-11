//! A hand-driven mesh of REAL kernel Nodes, and the random explorer that drives it (the I-20 salvage, 2026-10-08;
// it was the reviewer's scratch generator through three rounds of DESIGN-LEAVE, and the one that found the
// proposer-side double vote). Unlike sim/exec.ts there is no clock and no queue of its own: every membership frame a
// node ships goes into a per-direction FIFO, and the caller (or the seeded explorer below) picks which head frame
// lands next, which node ticks, who leaves, which pair is cut or healed, who gives up dialing, who is torn down,
// who restarts from its boot record, who joins. Data frames are dropped (the data plane is not under test). Every
// install anywhere is recorded; a second view at one epoch, across every life of every node, is a SPLIT.
// A plain module, not a test: sim/explore.test.ts asserts over a pinned range of seeds; a scratch script can import
// `explore` to run more.
import { Node } from '../kernel/node.ts'
import type { Vote } from '../kernel/membership.ts'
import { Framer, VERB, encodeControl } from '../kernel/codec.ts'
import { TAG, type BootRecord, type EffectSink, type Env } from '../kernel/env.ts'

//! the membership verbs: the only frames the mesh carries
const MV = new Set<number>([VERB.JOIN, VERB.PROPOSE, VERB.VOTE, VERB.VIEW, VERB.PULL, VERB.LEAVE])
const vname = (v: number) => Object.entries(VERB).find(([, x]) => x === v)?.[0] ?? String(v)
type Frame = { verb: number; bytes: Uint8Array; value: unknown }
type Boot = { epoch: number; members: [string, string][]; votedFor?: Vote }

export class Mesh {
  nodes = new Map<string, Node>()
  timers = new Map<string, Map<number, number>>() // uuid -> timer id -> tag
  linkOf = new Map<string, Map<string, number>>() // uuid -> peer -> current link id
  peerOf = new Map<string, Map<number, string>>() // uuid -> link id -> peer
  q = new Map<string, Frame[]>() // "a>b" -> frames waiting, in the order a sent them
  views = new Map<number, string>() // epoch -> the one members key installed at it
  splits: string[] = []
  left = new Map<string, boolean>()
  boots = new Map<string, BootRecord>()
  log: string[] = []
  #seq = 100
  durable: boolean
  constructor(durable = false) { this.durable = durable }

  //! add a node, fresh or restarted from a boot record (its incarnation bumped)
  add(uuid: string, boot?: Boot, incarnation = 1): Node {
    const me = this
    const none = () => {}
    const sink: EffectSink = {
      connect: none, close: none, apply: none, persist: none, snapshot: none, confirm: none, invoke: none, result: none, subRecs: none,
      cancel: (id) => { me.timers.get(uuid)!.delete(id) },
      timer: (id, tag) => { me.timers.get(uuid)!.set(id, tag) },
      //! frames ship on the CURRENT link to the peer only; a frame on a dead link is lost, as on a closed socket
      send: (link, bytes) => {
        const peer = me.peerOf.get(uuid)!.get(link)
        if (!peer || me.linkOf.get(uuid)!.get(peer) !== link) return
        for (const f of new Framer().push(bytes.slice())) if (MV.has(f.verb)) me.q.get(uuid + '>' + peer)!.push({ verb: f.verb, bytes: encodeControl(f.verb, f.value), value: f.value })
      },
      boot: (r) => { me.boots.set(uuid, JSON.parse(JSON.stringify(r))) },
      left: (clean) => { me.left.set(uuid, clean); me.log.push(`${uuid} left ${clean}`) },
    }
    const env: Env = { now: () => 0, rng: () => 0, sink }
    const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, hosts: [], durable: this.durable, incarnation, ...(boot ? { boot } : {}) }, env)
    //! every install is recorded; two members keys at one epoch is the split
    const inst = node.membership.install.bind(node.membership)
    node.membership.install = (n, view) => {
      inst(n, view)
      const key = view.members.map((m) => m[0]).sort().join(',')
      me.log.push(`${uuid} INSTALL ${view.epoch} {${key}}`)
      const prev = me.views.get(view.epoch)
      if (prev === undefined) me.views.set(view.epoch, key)
      else if (prev !== key) me.splits.push(`epoch ${view.epoch}: {${prev}} vs {${key}} (at ${uuid})`)
    }
    this.nodes.set(uuid, node)
    this.timers.set(uuid, new Map())
    this.linkOf.set(uuid, new Map())
    this.peerOf.set(uuid, new Map())
    for (const k of [...this.q.keys()]) if (k.startsWith(uuid + '>') || k.endsWith('>' + uuid)) this.q.delete(k)
    node.step({ kind: 'start' })
    return node
  }
  #qk(a: string, b: string) { const k = a + '>' + b; if (!this.q.has(k)) this.q.set(k, []); return k }
  //! connect a and b with a fresh link (both sides admitted), queues emptied
  connect(a: string, b: string) { this.open(a, b).land() }
  //! #hello — the HELLO this mesh writes for y (the node's own is dropped with every non-membership frame, so the
  // mesh's copy is what the peer reads; it says what the node's would)
  #hello(y: string): Record<string, unknown> { return { u: y, i: 1, l: `sim:${y}` } }
  //! open — the link comes up at both ends and each node ships its HELLO, but neither HELLO has LANDED yet: the
  // caller moves the mesh (a grant, a release, a tick) and then calls `land`, which feeds each side the HELLO the
  // other sent at open time (the holds as they were THEN, DESIGN-LEAVE §10.10.6: what changed while the HELLO was
  // in flight is the ask at admit's shape). connect() is open + land with nothing between.
  open(a: string, b: string): { land: () => void } {
    for (const [x, y] of [[a, b], [b, a]]) {
      const id = ++this.#seq
      this.linkOf.get(x)!.set(y, id); this.peerOf.get(x)!.set(id, y)
      this.q.set(this.#qk(x, y), [])
    }
    const hellos = new Map<string, Uint8Array>()
    for (const [x, y] of [[a, b], [b, a]]) {
      const n = this.nodes.get(x)!, id = this.linkOf.get(x)!.get(y)!
      n.step({ kind: 'linkUp', link: id, dialed: x < y, to: x < y ? `sim:${y}` : undefined })
      hellos.set(y, encodeControl(VERB.HELLO, this.#hello(y))) // y's HELLO as it left: read by x at land
    }
    return {
      land: () => {
        for (const [x, y] of [[a, b], [b, a]]) {
          const n = this.nodes.get(x)!, id = this.linkOf.get(x)!.get(y)!
          n.step({ kind: 'bytesIn', link: id, bytes: hellos.get(y)! })
          n.step({ kind: 'bytesIn', link: id, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
        }
      },
    }
  }
  //! one end sees its link drop
  down(x: string, y: string) {
    const id = this.linkOf.get(x)?.get(y)
    if (id === undefined) return
    this.linkOf.get(x)!.delete(y)
    this.nodes.get(x)?.step({ kind: 'linkDown', link: id, reason: 'close', ...(x < y ? { to: `sim:${y}` } : {}) })
  }
  //! cut the pair: both ends drop, every queued frame between them dies
  cut(a: string, b: string) { this.q.set(this.#qk(a, b), []); this.q.set(this.#qk(b, a), []); this.down(a, b); this.down(b, a) }
  //! deliver the head frame a→b (FIFO); returns its verb name, or null when nothing was there to land
  deliver(a: string, b: string): string | null {
    const f = this.q.get(a + '>' + b)?.shift()
    if (!f) return null
    const id = this.linkOf.get(b)?.get(a)
    if (id === undefined || !this.nodes.has(b)) return null
    this.log.push(`${a}->${b} ${vname(f.verb)} ${JSON.stringify(f.value)}`)
    this.nodes.get(b)!.step({ kind: 'bytesIn', link: id, bytes: f.bytes })
    return vname(f.verb)
  }
  //! fire x's heartbeat timer once
  tick(x: string) {
    const ts = this.timers.get(x)!
    const t = [...ts].filter(([, tag]) => tag === TAG.heartbeat).pop()
    if (!t) throw new Error(`${x} has no heartbeat timer`)
    ts.delete(t[0])
    this.nodes.get(x)!.step({ kind: 'timer', id: t[0], tag: TAG.heartbeat })
  }
  //! exhaust x's redial chain to y: fire each redial, refuse each dial, until the chain gives up
  giveUp(x: string, y: string) {
    for (let i = 0; i < 12; i++) {
      const ts = this.timers.get(x)!
      const t = [...ts].filter(([, tag]) => tag === TAG.redial).pop()
      if (t) { ts.delete(t[0]); this.nodes.get(x)!.step({ kind: 'timer', id: t[0], tag: TAG.redial }) }
      this.nodes.get(x)!.step({ kind: 'linkDown', link: 5000 + this.#seq++, reason: 'refused', to: `sim:${y}` })
    }
  }
  //! tear x down: every link cut, the node destroyed (its boot record stays, so it can restart)
  destroy(x: string) { for (const o of this.nodes.keys()) if (o !== x) this.cut(x, o); this.nodes.get(x)?.destroy(); this.nodes.delete(x) }
  //! a view installed everywhere, over a full mesh, with the queues emptied
  static formed(ids: string[], durable = false): Mesh {
    const m = new Mesh(durable)
    for (const u of ids) m.add(u)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m.connect(ids[i], ids[j])
    const v = encodeControl(VERB.VIEW, { e: 1, m: ids.map((u) => [u, `sim:${u}`]) })
    for (const u of ids) m.nodes.get(u)!.step({ kind: 'bytesIn', link: m.linkOf.get(u)!.get(ids.find((x) => x !== u)!)!, bytes: v })
    for (const k of m.q.keys()) m.q.set(k, [])
    m.log = []
    return m
  }
}

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

export interface Explored { seed: number; n: number; splits: string[]; trace: string[]; threw: string | null; maxEpoch: number; installs: number; restarts: number; quietSplit: string | null }

//! quietSplit — the sweep's split check (sim/leave-sweep.ts) on the mesh: after the random moves, every queued frame
// lands and everyone ticks, a few rounds over, with the cuts left as they are; then no two live nodes may be WRITABLE
// in different views, at any epochs (DESIGN-LEAVE §9: the invariant one-view-per-epoch does not see — a stale
// majority writable at a lower epoch beside the view without it). Null = no such pair.
export const quietSplit = (m: Mesh, rounds = 6): string | null => {
  for (let r = 0; r < rounds; r++) {
    for (let guard = 0; guard < 2000; guard++) {
      const qs = [...m.q.entries()].filter(([, f]) => f.length)
      if (!qs.length) break
      for (const [key] of qs) { const [a, b] = key.split('>'); m.deliver(a, b) }
    }
    for (const u of [...m.nodes.keys()]) if (m.timers.get(u)?.size) { try { m.tick(u) } catch { /* no heartbeat timer: a node mid-teardown */ } }
  }
  //! a node at epoch 0 holds no committed view (open genesis: a newcomer before any view reached it), so it is not
  // writable IN a view and cannot be one side of this split
  const open = [...m.nodes.values()].filter((x) => x.epoch > 0 && x.membership.gate(x).open)
  const views = new Set(open.map((x) => `${x.epoch}:${x.membership.view.members.map((v) => v[0])}`))
  return views.size > 1 ? `writable in different views: ${open.map((x) => `${x.uuid}@${x.epoch}{${x.membership.view.members.map((v) => v[0])}}`).join(' ')}` : null
}

//! explore — one seeded random schedule over a formed durable mesh of 2..5 nodes: one to three members leave at
// once, then `steps` random moves — a frame lands (most often), a node ticks, a node leaves, a pair is cut (with a
// few frames still landing first, as a socket close lets them) or healed, a dial chain gives up, a node whose leave
// was answered is torn down, a dead or live node restarts from its boot record, a sixth node joins. Stops at the
// first split. Safety only: one view per epoch across every life of every node — and, with `quiet`, the writable-
// split check at a quiet point after the moves (sim/leave-harness.ts; off by default, so the pinned range above is
// byte-identical with or without it).
export const explore = (seed: number, steps = 400, quiet = false): Explored => {
  const r = rng(seed)
  const n = 2 + Math.floor(r() * 4)
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee'].slice(0, n)
  const m = Mesh.formed(ids, true)
  const dead = new Set<string>()
  const lives = new Map<string, number>(ids.map((u) => [u, 1]))
  let fresh = 0, restarts = 0
  const trace: string[] = []
  let threw: string | null = null
  //! the burst: one to three members stop cleanly at once
  const k = 1 + Math.floor(r() * Math.min(3, n - 1))
  for (const u of [...ids].sort(() => r() - 0.5).slice(0, k)) { m.nodes.get(u)!.step({ kind: 'leave' }); trace.push(`leave ${u}`) }
  try {
    for (let s = 0; s < steps; s++) {
      const alive = [...m.nodes.keys()]
      if (!alive.length) break
      const x = r()
      if (x < 0.55) {
        const qs = [...m.q.entries()].filter(([, f]) => f.length)
        if (!qs.length) continue
        const [key] = qs[Math.floor(r() * qs.length)]
        const [a, b] = key.split('>')
        trace.push(`d ${a}>${b} ${m.deliver(a, b)}`)
      } else if (x < 0.75) {
        const u = alive[Math.floor(r() * alive.length)]
        m.tick(u); trace.push(`t ${u}`)
      } else if (x < 0.80) {
        const u = alive[Math.floor(r() * alive.length)]
        if (!m.nodes.get(u)!.membership.leaving) { m.nodes.get(u)!.step({ kind: 'leave' }); trace.push(`leave ${u}`) }
      } else if (x < 0.85) {
        const a = alive[Math.floor(r() * alive.length)], b = alive[Math.floor(r() * alive.length)]
        if (a !== b && m.linkOf.get(a)!.has(b)) {
          const keep = Math.floor(r() * 3) // TCP: some frames already sent may still land before the close
          for (let i = 0; i < keep; i++) { m.deliver(a, b); m.deliver(b, a) }
          m.cut(a, b); trace.push(`cut ${a}-${b}`)
        }
      } else if (x < 0.90) {
        const a = alive[Math.floor(r() * alive.length)], b = alive[Math.floor(r() * alive.length)]
        if (a !== b && !m.linkOf.get(a)!.has(b) && !m.linkOf.get(b)!.has(a)) { m.connect(a, b); trace.push(`heal ${a}-${b}`) }
      } else if (x < 0.93) {
        const a = alive[Math.floor(r() * alive.length)], b = [...ids, ...alive].filter((u) => u !== a)[Math.floor(r() * ids.length)]
        if (b && !m.linkOf.get(a)!.has(b)) { m.giveUp(a, b); trace.push(`giveup ${a}->${b}`) }
      } else if (x < 0.97) {
        //! teardown of a node whose leave was answered (the shell destroys it on `left`)
        const done = alive.filter((u) => m.left.has(u) && !dead.has(u))
        if (done.length) { const u = done[Math.floor(r() * done.length)]; m.destroy(u); dead.add(u); trace.push(`destroy ${u}`) }
      } else if (x < 0.985) {
        //! crash + restart from the boot record: a torn-down node, or a live one
        const pool = [...dead, ...alive]
        const u = pool[Math.floor(r() * pool.length)]
        const b = m.boots.get(u)
        if (b && b.epoch > 0) {
          if (m.nodes.has(u)) m.destroy(u)
          dead.delete(u); m.left.delete(u)
          const inc = (lives.get(u) ?? 1) + 1; lives.set(u, inc)
          m.add(u, { epoch: b.epoch, members: b.members, votedFor: b.votedFor }, inc)
          for (const o of m.nodes.keys()) if (o !== u && r() < 0.7) m.connect(u, o)
          restarts++; trace.push(`restart ${u}`)
        }
      } else if (fresh < 1) {
        fresh++
        m.add('ff')
        for (const o of alive) if (r() < 0.6) m.connect('ff', o)
        trace.push('fresh ff')
      }
      if (m.splits.length) break
    }
  } catch (e) { threw = (e as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? String(e) }
  let installs = 0
  for (const l of m.log) if (l.includes(' INSTALL ')) installs++
  let qs: string | null = null
  if (quiet && !threw && !m.splits.length) { try { qs = quietSplit(m) } catch (e) { threw = (e as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? String(e) } }
  return { seed, n, splits: m.splits, trace, threw, maxEpoch: Math.max(0, ...m.views.keys()), installs, restarts, quietSplit: qs }
}
