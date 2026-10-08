//! ── api/directory — the per-box rendezvous directory (V4-3, docs/DESIGN-DIRECTORY.md) ──────────────
// One fixed loopback address per box (RENDEZVOUS). Whoever binds it hosts the system resource
// `#directory`: a soft-state registry `name → {uuid: listen}` held in a data proxy on the host —
// never a log, never a WAL. Every dialable user instance opens a `#directory` CLIENT to it:
// servers `register` {name, uuid, listen}; everyone opens `lookup(name)` as a LIVE subscription
// whose folded address list feeds the kernel's dial set through the `discover` event.
//
// Why method-plane state and not replicated `data`: the registry is soft state that must die
// with its registrant and with its host. Through the method plane both are structural — an entry
// lives exactly as long as its registrant's TCP connection to the CURRENT host (peer-down cleanup
// keyed by uuid transitions), and a takeover is the existing Caller failover: the lookup
// re-subscribes and the fresh snapshot root-replaces the mirror, registrants re-register on the new
// primary. Through the replication log, the old host's cells would outlive it (anti-entropy
// resurrects them from clients) and need a sweep against a registry the new host must first
// rebuild — rejected.
//
// Hosting is first-to-bind among SERVER instances (a discovery role only — the data role of every
// resource stays a pure function of its config, V4-2). Losers of the bind race are clients; when
// the host dies, every server's directory client sees its link drop and retries the bind after a
// jittered, exponentially backed-off delay until it hosts or a link is back. Clients host nothing
// (Q1): serving is a declared act, and a watcher-hosted directory would churn with every watcher
// restart.
//
// Trust boundary, stated: the directory is as unauthenticated as the peer plane it serves —
// loopback IS the trust boundary. Any local process can register any name (it could equally dial
// the resource and speak HELLO with that name); the caps below bound a runaway, they do not
// authenticate anyone. A routable rendezvous is an operator's explicit act, never a default.

import net from 'node:net'
import { proxy, snapshot } from './substrate.ts'
import type { Context } from './methods.ts'
import type { Fero, FeroOpts } from './types.ts'

//! DIRECTORY — the system resource name. `#` is the reserved prefix: fero() refuses it for users, so
// the name can never be taken by accident, and it reads as a system node in captures and journals.
export const DIRECTORY = '#directory'
//! RENDEZVOUS — "FERO" on a keypad. Below every OS's ephemeral range (Linux 32768–60999, macOS and
// Windows 49152–65535) so listen(0) can never hand the port to a resource; loopback only — the peer
// plane is unauthenticated. (Windows with Hyper-V reserves random low bands: a reserved 3376 binds
// with EACCES/EADDRNOTAVAIL — surfaced on cluster.me.rendezvous.error, and the retry backs off.)
export const RENDEZVOUS = '127.0.0.1:3376'

//! rendezvousDefault — the process-wide default: FERO_RENDEZVOUS (an address, or 'off' / 'false' /
// '0') beats the constant; an explicit `rendezvous:` in config beats BOTH (the env var sets the
// process default, it does not isolate an application that names its directory). The test battery
// runs with 'off' so explicit-topology tests never meet another tenant's directory on a shared box;
// discovery tests opt in with a free port each. A malformed value is refused at fero() time.
export const rendezvousDefault = (): string | false => {
  const env = process.env.FERO_RENDEZVOUS?.trim()
  if (env === undefined || env === '') return RENDEZVOUS
  if (env === 'off' || env === 'false' || env === '0') return false
  return env
}

//! isAddr — 'host:port' with a non-empty host and an all-digit port 1–65535; `zero` admits port 0
// (the free-port LISTEN default — never a dialable rendezvous)
export const isAddr = (a: unknown, zero = false): a is string => {
  if (typeof a !== 'string') return false
  const i = a.lastIndexOf(':')
  if (i <= 0) return false
  const port = a.slice(i + 1)
  if (!/^\d{1,5}$/.test(port)) return false
  const p = Number(port)
  return (p >= 1 || (zero && p === 0)) && p <= 65535
}
export const hostOf = (a: string): string => a.slice(0, a.lastIndexOf(':'))
export const portOf = (a: string): string => a.slice(a.lastIndexOf(':') + 1)
//! localish — a host spelling that reaches THIS box's loopback listeners: a loopback literal,
// `localhost`, or a wildcard (a wildcard bind answers on 127.0.0.1 too)
export const localish = (h: string): boolean =>
  h === '' || h === 'localhost' || h.startsWith('127.') || h === '[::1]' || h === '::1' || h === '0.0.0.0' || h === '::' || h === '[::]'
//! sameSocket — would binding `listen` take the socket `rendezvous` dials? Same port, and a host that
// lands on the same interface class (both localish, or the identical spelling). The compose-time
// guard uses this so `0.0.0.0:3376` / `localhost:3376` / `[::]:3376` cannot squat the directory.
export const sameSocket = (listen: string, rendezvous: string): boolean =>
  portOf(listen) === portOf(rendezvous) && (hostOf(listen) === hostOf(rendezvous) || (localish(hostOf(listen)) && localish(hostOf(rendezvous))))

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
export const afterFold = (fn: () => void): (() => void) => {
  let pending = false
  return () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; fn() }) }
}

//! GRACE — cleanup passes a never-published registrant survives before it is dropped: an entry whose
// caller was admitted (it registered) but has not yet appeared in a published `peers` row is in the
// HELLO→fold window, not dead; if it still is not up after this many passes, its link died inside
// that window and the entry would otherwise leak until the host dies.
export const GRACE = 3
//! MAX_PER_CALLER — entries one directory client may hold (a runaway registrant, not an attacker: the
// plane is unauthenticated by design — see the banner). Refused loudly past the cap.
export const MAX_PER_CALLER = 4096

//! hostMethods — the `#directory` host's method table + its peer-down cleanup. Exported as a TEST
// SEAM (api/directory.test.ts drives it without sockets — the fold-order defect above is pinned
// deterministically there). `owners` maps a registrant (the calling link's uuid, Context.peer) to
// the entries it made; `owner` maps an entry to its CURRENT registrant — a later registrant of the
// same (name, uuid) wins the cell (a dir-restored identity restarting while its wedged predecessor's
// link is still open), and only the current owner's death drops it. `registry` is the data proxy
// `lookup` hands out as live child views (rows are never removed — a whole-row remove does not
// stream to a child-view subscriber — only fields are).
//! `selfOf` is the host's own uuid once it exists: a local invoke carries it as ctx.peer (api/methods.ts),
// and the host refuses to register under itself — the wire stays the only way in.
export const hostMethods = (peersOf: () => Peers, selfOf: () => string | undefined = () => undefined): { methods: Record<string, (a: unknown, ctx: Context) => unknown>; onPeers: () => void } => {
  const registry: any = proxy({})
  const owners = new Map<string, Set<string>>()
  const owner = new Map<string, string>()
  //! seen — owners the host has PUBLISHED as up at least once; grace — passes a not-yet-seen owner waited
  const seen = new Set<string>()
  const grace = new Map<string, number>()
  const key = (name: string, uuid: string) => JSON.stringify([name, uuid]) // no delimiter a name could contain
  const rows = (): Record<string, Row> => (snapshot(registry) as Record<string, Row>) ?? {}
  const drop = (k: string) => {
    const [name, uuid] = JSON.parse(k) as [string, string]
    owner.delete(k)
    if (rows()[name]?.[uuid] === undefined) return
    registry.get(name).get(uuid).remove()
  }
  const forget = (peer: string, keys: Set<string>) => {
    owners.delete(peer); seen.delete(peer); grace.delete(peer)
    for (const k of keys) if (owner.get(k) === peer) drop(k)
  }
  //! peer-down cleanup: every entry a registrant made goes when its uuid is no longer up. Keyed by
  // uuid TRANSITIONS off the host's cluster.peers fold, read AFTER the fold — a registrant that
  // reconnects before its old link's close is processed keeps its uuid up, so nothing is deleted; if
  // the close lands first the entries go and the registrant's link-up re-register restores them.
  // Entry lifetime IS the registrant's TCP connection: a hung-but-connected process keeps its entry
  // (the kernel runs no failure detector over client links; a crash or a clean close drops the
  // socket at once). Runs on every host fold AND at the end of every register (see there).
  const onPeers = afterFold(() => {
    const peers = peersOf()
    for (const [peer, keys] of owners) {
      if (peers[peer]?.up) { seen.add(peer); grace.delete(peer); continue }
      if (seen.has(peer)) { forget(peer, keys); continue }
      const g = (grace.get(peer) ?? 0) + 1
      if (g >= GRACE) forget(peer, keys)
      else grace.set(peer, g)
    }
  })
  return {
    methods: {
      register: (a: unknown, ctx: Context) => {
        const { name, uuid, listen } = (a ?? {}) as { name?: unknown; uuid?: unknown; listen?: unknown }
        if (typeof name !== 'string' || name === '' || name.startsWith('#')) throw new Error('register: name must be a non-empty user resource name (no # prefix)')
        if (typeof uuid !== 'string' || uuid === '' || uuid.includes('~')) throw new Error('register: uuid must be a non-empty string without ~')
        if (!isAddr(listen)) throw new Error("register: listen must be 'host:port' with a non-empty host and a port 1–65535")
        if (ctx.peer === undefined || ctx.peer === selfOf()) throw new Error('register: only a directory client may register (no caller identity)')
        let mine = owners.get(ctx.peer)
        if (!mine) owners.set(ctx.peer, (mine = new Set()))
        const k = key(name, uuid)
        if (!mine.has(k) && mine.size >= MAX_PER_CALLER) throw new Error(`register: this caller already holds ${MAX_PER_CALLER} entries`)
        const prev = owner.get(k)
        if (prev !== undefined && prev !== ctx.peer) owners.get(prev)?.delete(k) // the later registrant is authoritative
        owner.set(k, ctx.peer)
        mine.add(k)
        if (rows()[name] === undefined) registry.set(name, { [uuid]: listen })
        else registry.get(name).set(uuid, listen)
        //! a pass NOW (coalesced after this fold): the caller's peer row is already published — its HELLO
        // folded before its call could arrive — so the caller is `seen` from its first entry. A registrant
        // used to be seen only by a LATER fold at the host, and with two servers and nothing else no later
        // fold ever came: the second server's clean leave then sat out the GRACE budget while every lookup
        // handed out its dead address (I-34).
        onPeers()
        return true
      },
      lookup: (a: unknown) => {
        if (typeof a !== 'string' || a === '') throw new Error('lookup: name must be a non-empty string')
        return registry.get(a)
      },
    },
    onPeers,
  }
}

export interface DirectoryState { hosting: boolean; up: boolean; error?: string }

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
  //! onState — hosting/up/error transitions, for cluster.me.rendezvous
  onState: (s: DirectoryState) => void
}

//! RETRY_BASE/RETRY_CAP — the bind-retry loop: jittered 50–250 ms for the takeover race (N servers
// losing one host must not stampede the port), doubling per consecutive failure up to the cap, so a
// permanently held port costs one cheap probe every few seconds, not a full Runtime 20× a second.
const RETRY_BASE = 50
const RETRY_CAP = 5000

export class Directory {
  #o: DirectoryOpts
  client: Fero | null = null
  host: Fero | null = null
  #destroyed = false
  #up = false
  #error: string | undefined
  #lastPeers = ''
  #retry: NodeJS.Timeout | null = null
  #fails = 0
  constructor(o: DirectoryOpts) { this.#o = o }
  get hosting(): boolean { return this.host !== null }
  get up(): boolean { return this.#up }
  get error(): string | undefined { return this.#error }
  #state(): DirectoryState { return { hosting: this.hosting, up: this.#up, ...(this.#error !== undefined ? { error: this.#error } : {}) } }
  #setError(e: string | undefined) { if (e !== this.#error) { this.#error = e; this.#o.onState(this.#state()) } }

  //! start — (servers) one bind attempt first, so a fresh box gets its directory on the first server
  // with no round trip; then the client, its registration on every primary, and the live lookup.
  async start(): Promise<void> {
    if (this.#o.serve) await this.#tryHost()
    if (this.#destroyed) return
    const o = this.#o
    this.client = await o.compose(DIRECTORY, { hosts: [o.addr], heartbeat: { ms: o.heartbeatMs }, ...(o.redialMs !== undefined ? { redial: { ms: o.redialMs } } : {}) }, true)
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
      if (up !== this.#up) { this.#up = up; this.#o.onState(this.#state()) }
      if (up) { this.#stopRetry(); this.#fails = 0; void this.#register() }
      else if (this.#o.serve && !this.hosting) this.#armRetry()
    }))
    //! the live lookup: one subscription, re-subscribed by the Caller on every primary change (a fresh
    // host's snapshot root-replaces the mirror). Folds to the address set minus own listen.
    const h = c.methods.lookup(o.name) as { tap: (fn: () => void) => void; ready: Promise<void> }
    //! a failed lookup (the host's handler threw) is the directory's trouble, not the server's: it shows on
    // cluster.me.rendezvous.error instead of exiting the process as an unhandled `ready` rejection would
    h.ready.catch((e: unknown) => { if (!this.#destroyed) this.#setError(`lookup: ${(e as Error)?.message ?? String(e)}`) })
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

  //! #register — idempotent, re-issued on every primary; a host REFUSAL is deterministic (bad listen,
  // the per-caller cap) so it is surfaced on cluster.me.rendezvous.error rather than retried blindly
  async #register(): Promise<void> {
    const c = this.client
    const listen = this.#o.listen()
    if (!c || !this.#o.serve || listen === undefined) return
    try {
      await (c.methods.register as (a: unknown, o?: unknown) => Promise<unknown>)({ name: this.#o.name, uuid: this.#o.uuid, listen }, { retry: true, timeout: 5000 })
      this.#setError(undefined)
    } catch (e) {
      if (!this.#destroyed) this.#setError(`register: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  //! #probe — can this process bind the rendezvous? One listen()/close() — the cheap gate in front of
  // the full compose, so a held port costs a socket call per attempt, not a Runtime. Resolves the
  // errno on failure: EADDRINUSE is the ordinary outcome (someone hosts, or a squatter); anything
  // else (EACCES — a reserved band; EADDRNOTAVAIL — an interface that is not here …) is recorded.
  #probe(): Promise<string | null> {
    const host = hostOf(this.#o.addr), port = Number(portOf(this.#o.addr))
    return new Promise((res) => {
      const s = net.createServer()
      s.once('error', (err: NodeJS.ErrnoException) => res(err.code ?? 'EUNKNOWN'))
      s.listen(port, host, () => s.close(() => res(null)))
    })
  }

  //! #tryHost — probe, then one real bind; losing to another server between the two is the ordinary
  // race and reads as EADDRINUSE like any other.
  async #tryHost(): Promise<void> {
    if (this.hosting || this.#destroyed) return
    const o = this.#o
    const code = await this.#probe()
    if (this.#destroyed) return
    if (code !== null) { this.#fails++; if (code !== 'EADDRINUSE') this.#setError(`bind ${o.addr}: ${code}`); return }
    let host: Fero | null = null
    const { methods, onPeers } = hostMethods(
      () => (host ? (snapshot(host.cluster) as { peers: Peers }).peers ?? {} : {}),
      () => (host ? (snapshot(host.cluster) as { me: { uuid: string } }).me.uuid : undefined))
    try {
      //! `methods:` makes the directory PROTECTED (V4-5): its clients only ever CALL register/lookup, so a
      // stray plain write into the box's directory is refused at the relay, never folded
      host = await o.compose(DIRECTORY, { listen: o.addr, heartbeat: { ms: o.heartbeatMs }, ...(o.redialMs !== undefined ? { redial: { ms: o.redialMs } } : {}), methods }, true)
      if (this.#destroyed) { await host.destroy(); return }
      this.host = host
      this.#fails = 0
      host.cluster.tap(onPeers)
      if (this.#error?.startsWith('bind ')) this.#error = undefined
      this.#o.onState(this.#state())
    } catch (err) {
      this.#fails++
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== undefined && code !== 'EADDRINUSE') this.#setError(`bind ${o.addr}: ${code}`)
    }
  }

  //! the bind-retry loop (servers, while the link is down and nobody here hosts): jittered base for
  // the takeover race, doubling per consecutive failure to the cap; stops the moment a link is up or
  // this instance hosts.
  #armRetry() {
    if (this.#retry || this.#destroyed) return
    const delay = Math.min(RETRY_CAP, (RETRY_BASE + Math.floor(Math.random() * 4 * RETRY_BASE)) * 2 ** Math.min(this.#fails, 8))
    this.#retry = setTimeout(async () => {
      this.#retry = null
      if (this.#destroyed || this.#up || this.hosting) return
      await this.#tryHost()
      if (!this.hosting && !this.#up && !this.#destroyed) this.#armRetry()
    }, delay)
    this.#retry.unref?.()
  }
  #stopRetry() { if (this.#retry) { clearTimeout(this.#retry); this.#retry = null } }

  //! destroy — the client first (its link drops ⇒ the host forgets this instance's entries), then the
  // hosted directory if this instance holds it (⇒ every other server's retry loop races for the port).
  // A #tryHost in flight sees #destroyed and destroys what it built.
  async destroy(): Promise<void> {
    this.#destroyed = true
    this.#stopRetry()
    const c = this.client; this.client = null
    if (c) await c.destroy()
    const h = this.host; this.host = null
    if (h) await h.destroy()
  }
}
