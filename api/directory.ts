//! ── api/directory — the per-box rendezvous directory (V4-3, DESIGN-DIRECTORY.md) ──────────────
// One fixed loopback address per box (RENDEZVOUS). Whoever binds it hosts the system resource
// `#directory`: a soft-state registry `name → {uuid: listen}` held in a data proxy on the host —
// never a log, never a WAL. Every dialable user instance opens a `#directory` CLIENT to it:
// servers `register` {name, uuid, listen}; everyone opens `lookup(name)` as a LIVE subscription
// whose folded address list feeds the kernel's dial set through the `discover` event.
//
// Why method-plane state and not replicated `data`: the registry is soft state that must die
// with its registrant and with its host. Through the method plane both are structural — an entry
// lives exactly as long as its registrant's link to the CURRENT host (peer-down cleanup keyed by
// uuid transitions), and a takeover is the existing Caller failover: the lookup re-subscribes and
// the fresh snapshot root-replaces the mirror, registrants re-register on the new primary. Through
// the replication log, the old host's cells would outlive it (anti-entropy resurrects them from
// clients) and need a sweep against a registry the new host must first rebuild — rejected.
//
// Hosting is first-to-bind among SERVER instances (a discovery role only — the data role of every
// resource stays a pure function of its config, V4-2). Losers of the bind race are clients; when
// the host dies, every server's directory client sees its link drop and retries the bind after a
// jittered delay until it hosts or a link is back. Clients host nothing (Q1): serving is a declared
// act, and a watcher-hosted directory would churn with every watcher restart.

import { proxy, snapshot } from './substrate.ts'
import type { Context } from './methods.ts'
import type { Fero, FeroOpts } from './types.ts'

//! DIRECTORY — the system resource name. `#` is the reserved prefix: fero() refuses it for users, so
// the name can never be taken by accident, and it reads as a system node in captures and journals.
export const DIRECTORY = '#directory'
//! RENDEZVOUS — "FERO" on a keypad. Below Linux's ephemeral range (32768–60999) so listen(0) can
// never hand the port to a resource; loopback only — the peer plane is unauthenticated.
export const RENDEZVOUS = '127.0.0.1:3376'

//! rendezvousDefault — the process-wide default: FERO_RENDEZVOUS (an address, or 'off') beats the
// constant. The test battery runs with 'off' so explicit-topology tests never meet another tenant's
// directory on a shared box; discovery tests opt in with a free port each.
export const rendezvousDefault = (): string | false => {
  const env = process.env.FERO_RENDEZVOUS
  if (env === undefined || env === '') return RENDEZVOUS
  if (env === 'off' || env === 'false' || env === '0') return false
  return env
}

//! isAddr — 'host:port' with a numeric port in range; the host part non-empty
export const isAddr = (a: unknown): a is string => {
  if (typeof a !== 'string') return false
  const i = a.lastIndexOf(':')
  if (i <= 0) return false
  const p = Number(a.slice(i + 1))
  return Number.isInteger(p) && p >= 0 && p <= 65535
}

//! Compose — the composer's internal entry (api/index.ts): system=true admits a `#` name and skips
// the directory for the instance itself (a directory never meets a directory).
export type Compose = (name: string, opts: FeroOpts, system: true) => Promise<Fero>

type Row = Record<string, string>
type Peers = Record<string, { up: boolean }>

//! afterFold — coalesce a proxy tap into ONE reaction after the current synchronous fold. A cluster
// fold sets several rows in sequence (epoch, writable, members, peers …) and the tap fires on EACH
// set, so a reaction reading `peers` from inside the tap can observe the row from BEFORE this fold —
// the defect that dropped a registration arriving in the same TCP chunk as its HELLO. A microtask
// runs once the fold's synchronous sets are all in, and never re-enters a kernel step from a tap.
const afterFold = (fn: () => void): (() => void) => {
  let pending = false
  return () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; fn() }) }
}

//! GRACE — cleanup passes a never-published registrant survives before it is dropped: an entry whose
// caller was admitted (it registered) but has not yet appeared in a published `peers` row is in the
// HELLO→fold window, not dead; if it still is not up after this many passes, its link died inside
// that window and the entry would otherwise leak until the host dies.
const GRACE = 3

//! hostMethods — the `#directory` host's method table + its peer-down cleanup. `owners` maps a
// registrant (the calling link's uuid, Context.peer) to the entries it made; `registry` is the data
// proxy `lookup` hands out as live child views (rows are never removed — a whole-row remove does not
// stream to a child-view subscriber — only fields are).
const hostMethods = (peersOf: () => Peers): { methods: Record<string, (a: unknown, ctx: Context) => unknown>; onPeers: () => void } => {
  const registry: any = proxy({})
  const owners = new Map<string, Set<string>>()
  //! seen — owners the host has PUBLISHED as up at least once; grace — passes a not-yet-seen owner waited
  const seen = new Set<string>()
  const grace = new Map<string, number>()
  const rows = (): Record<string, Row> => (snapshot(registry) as Record<string, Row>) ?? {}
  const drop = (name: string, uuid: string) => {
    if (rows()[name]?.[uuid] === undefined) return
    registry.get(name).get(uuid).remove()
  }
  const forget = (peer: string, keys: Set<string>) => {
    owners.delete(peer); seen.delete(peer); grace.delete(peer)
    for (const k of keys) { const i = k.indexOf(' '); drop(k.slice(0, i), k.slice(i + 1)) }
  }
  return {
    methods: {
      register: (a: unknown, ctx: Context) => {
        const { name, uuid, listen } = (a ?? {}) as { name?: unknown; uuid?: unknown; listen?: unknown }
        if (typeof name !== 'string' || name === '' || name.startsWith('#')) throw new Error('register: name must be a non-empty user resource name (no # prefix)')
        if (typeof uuid !== 'string' || uuid === '' || uuid.includes('~')) throw new Error('register: uuid must be a non-empty string without ~')
        if (!isAddr(listen)) throw new Error("register: listen must be 'host:port'")
        if (ctx.peer === undefined) throw new Error('register: only a directory client may register (no caller identity)')
        let mine = owners.get(ctx.peer)
        if (!mine) owners.set(ctx.peer, (mine = new Set()))
        mine.add(name + ' ' + uuid)
        if (rows()[name] === undefined) registry.set(name, { [uuid]: listen })
        else registry.get(name).set(uuid, listen)
        return true
      },
      lookup: (a: unknown) => {
        if (typeof a !== 'string' || a === '') throw new Error('lookup: name must be a non-empty string')
        return registry.get(a)
      },
    },
    //! peer-down cleanup: every entry a registrant made goes when its uuid is no longer up. Keyed by
    // uuid TRANSITIONS off the host's cluster.peers fold, read AFTER the fold — a registrant that
    // reconnects before its old link's close is processed keeps its uuid up, so nothing is deleted; if
    // the close lands first the entries go and the registrant's link-up re-register restores them.
    onPeers: afterFold(() => {
      const peers = peersOf()
      for (const [peer, keys] of owners) {
        if (peers[peer]?.up) { seen.add(peer); grace.delete(peer); continue }
        if (seen.has(peer)) { forget(peer, keys); continue }
        const g = (grace.get(peer) ?? 0) + 1
        if (g >= GRACE) forget(peer, keys)
        else grace.set(peer, g)
      }
    }),
  }
}

export interface DirectoryOpts {
  compose: Compose
  addr: string
  //! name/uuid/listen — the OWNING instance's identity; `listen` is undefined on a client (looks up,
  // never registers). Read lazily: a port-0 server's listen is known only after its runtime started.
  name: string
  uuid: string
  listen: () => string | undefined
  serve: boolean
  heartbeatMs: number
  redialMs?: number
  //! onHosts — the folded address set (minus own listen): the composer posts it as `discover`
  onHosts: (hosts: string[]) => void
  //! onState — hosting/up transitions, for cluster.me.rendezvous
  onState: (s: { hosting: boolean; up: boolean }) => void
}

export class Directory {
  #o: DirectoryOpts
  client: Fero | null = null
  host: Fero | null = null
  #destroyed = false
  #up = false
  #lastPeers = ''
  #retry: NodeJS.Timeout | null = null
  constructor(o: DirectoryOpts) { this.#o = o }
  get hosting(): boolean { return this.host !== null }
  get up(): boolean { return this.#up }

  //! start — (servers) one bind attempt first, so a fresh box gets its directory on the first server
  // with no round trip; then the client, its registration on every primary, and the live lookup.
  async start(): Promise<void> {
    if (this.#o.serve) await this.#tryHost()
    if (this.#destroyed) return
    const o = this.#o
    this.client = await o.compose(DIRECTORY, { hosts: [o.addr], heartbeatMs: o.heartbeatMs, ...(o.redialMs !== undefined ? { redialMs: o.redialMs } : {}) }, true)
    if (this.#destroyed) { await this.client.destroy(); this.client = null; return }
    const c = this.client
    //! a server that lost the first bind (another host, or a squatter) starts the retry loop NOW — the
    // link-down transition below never fires for a directory that was never up
    if (o.serve && !this.hosting) this.#armRetry()
    //! the directory link, from the client's own cluster fold (read after the fold): up ⇒ (servers)
    // register on THIS primary; down ⇒ (servers) start the bind-retry loop. The peers key changes on
    // every primary change, so a takeover (new host uuid) re-registers even without an observed gap.
    c.cluster.tap(afterFold(() => {
      if (this.#destroyed) return
      const peers = (snapshot(c.cluster) as { peers: Peers }).peers ?? {}
      const key = Object.keys(peers).filter((u) => peers[u].up).sort().join(',')
      if (key === this.#lastPeers) return
      this.#lastPeers = key
      const up = key !== ''
      if (up !== this.#up) { this.#up = up; this.#o.onState({ hosting: this.hosting, up }) }
      if (up) { this.#stopRetry(); void this.#register() }
      else if (this.#o.serve && !this.hosting) this.#armRetry()
    }))
    //! the live lookup: one subscription, re-subscribed by the Caller on every primary change (a fresh
    // host's snapshot root-replaces the mirror). Folds to the address set minus own listen.
    const h = c.methods.lookup(o.name) as { tap: (fn: () => void) => void }
    let last = ''
    h.tap(afterFold(() => {
      if (this.#destroyed) return
      const row = (snapshot(h) as Row | undefined) ?? {}
      const me = o.listen()
      const hosts = [...new Set(Object.values(row).filter((a) => typeof a === 'string' && a !== me))].sort()
      const key = hosts.join(',')
      if (key === last) return
      last = key
      o.onHosts(hosts)
    }))
  }

  async #register(): Promise<void> {
    const c = this.client
    const listen = this.#o.listen()
    if (!c || !this.#o.serve || listen === undefined) return
    try { await (c.methods.register as (a: unknown, o?: unknown) => Promise<unknown>)({ name: this.#o.name, uuid: this.#o.uuid, listen }, { retry: true, timeout: 5000 }) }
    catch { /* the next link-up re-registers; a dead directory is observable via cluster.me.rendezvous */ }
  }

  //! #tryHost — one bind attempt; EADDRINUSE (someone else hosts, or a squatter) is the ordinary outcome.
  async #tryHost(): Promise<void> {
    if (this.hosting || this.#destroyed) return
    const o = this.#o
    let host: Fero | null = null
    const { methods, onPeers } = hostMethods(() => (host ? (snapshot(host.cluster) as { peers: Peers }).peers ?? {} : {}))
    try {
      host = await o.compose(DIRECTORY, { listen: o.addr, heartbeatMs: o.heartbeatMs, ...(o.redialMs !== undefined ? { redialMs: o.redialMs } : {}), ...methods }, true)
      if (this.#destroyed) { await host.destroy(); return }
      this.host = host
      host.cluster.tap(onPeers)
      this.#o.onState({ hosting: true, up: this.#up })
    } catch { /* not ours to host right now */ }
  }

  //! the bind-retry loop (servers, while the link is down and nobody here hosts): jittered 50–250 ms so N
  // servers losing one host do not stampede the port; every attempt is one listen() call.
  #armRetry() {
    if (this.#retry || this.#destroyed) return
    this.#retry = setTimeout(async () => {
      this.#retry = null
      if (this.#destroyed || this.#up || this.hosting) return
      await this.#tryHost()
      if (!this.hosting && !this.#up && !this.#destroyed) this.#armRetry()
    }, 50 + Math.floor(Math.random() * 200))
    this.#retry.unref?.()
  }
  #stopRetry() { if (this.#retry) { clearTimeout(this.#retry); this.#retry = null } }

  //! destroy — the client first (its link drops ⇒ the host forgets this instance's entries), then the
  // hosted directory if this instance holds it (⇒ every other server's retry loop races for the port).
  async destroy(): Promise<void> {
    this.#destroyed = true
    this.#stopRetry()
    const c = this.client; this.client = null
    if (c) await c.destroy()
    const h = this.host; this.host = null
    if (h) await h.destroy()
  }
}
