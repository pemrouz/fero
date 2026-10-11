//! ── api/directory — the per-box rendezvous directory (V4-3, docs/DESIGN-DIRECTORY.md) ──────────────
// One fixed loopback address per box (RENDEZVOUS). Whoever binds it hosts the system resource
// `#directory`: a soft-state registry `name → {uuid: listen}` held in a data proxy on the host —
// never a log, never a WAL. Every dialable user instance meets it through a `#directory` CLIENT (one per
// process, shared by every instance there — see `share` below):
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
//! unmap — an IPv4-mapped IPv6 spelling as the IPv4 address it stands for: `[::ffff:127.0.0.1]`,
// `::FFFF:127.0.0.1`, `0:0:0:0:0:ffff:127.0.0.1` and the hex form `::ffff:7f00:1` all dial (and bind)
// the same socket as `127.0.0.1` — measured on this box: a mapped dial reaches a 127.0.0.1 listener and
// a 127.0.0.1 dial reaches a mapped bind. Every other spelling comes back as it was. Brackets come off
// only as a pair.
const MAPPED = /^(?:(?:0{1,4}:){5}|::)ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i
export const unmap = (h: string): string => {
  const m = MAPPED.exec(h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h)
  if (m === null) return h
  if (m[1] !== undefined) return m[1]
  const a = parseInt(m[2], 16), b = parseInt(m[3], 16)
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
}
//! localish — a host spelling that reaches THIS box's loopback listeners: a loopback literal,
// `localhost` (in any case: host names are case-blind), or a wildcard (a wildcard bind answers on
// 127.0.0.1 too). An IPv4-mapped spelling reads as the IPv4 address it maps (unmap).
export const localish = (raw: string): boolean => {
  const h = unmap(raw)
  return h === '' || h.toLowerCase() === 'localhost' || h.startsWith('127.') || h === '[::1]' || h === '::1' || h === '0.0.0.0' || h === '::' || h === '[::]'
}
//! sameSocket — would binding `listen` take the socket `rendezvous` dials? Same port, and a host that
// lands on the same interface class (both localish, or the identical spelling). The compose-time
// guard uses this so `0.0.0.0:3376` / `localhost:3376` / `[::]:3376` cannot squat the directory.
export const sameSocket = (listen: string, rendezvous: string): boolean =>
  portOf(listen) === portOf(rendezvous) && (hostOf(listen) === hostOf(rendezvous) || (localish(hostOf(listen)) && localish(hostOf(rendezvous))))

//! ── cross-box discovery (docs/DESIGN-DIRECTORY.md §11) ──
// A `hosts` entry with NO port names another box: "ask that box's directory". The port is this
// instance's rendezvous port (every box runs its directory on the same port, 3376 unless moved). The
// instance only ASKS there — it looks its name up, it never registers and never hosts on another box.

//! loopbackHost — a host spelling that only THIS box can reach (a wildcard is not one: a socket bound
// to 0.0.0.0 answers other boxes too). An IPv4-mapped loopback (`[::ffff:127.0.0.1]`) is one; a mapped
// routable address (`[::ffff:10.0.0.5]`) is not.
export const loopbackHost = (raw: string): boolean => {
  const h = unmap(raw)
  return h.toLowerCase() === 'localhost' || h.startsWith('127.') || h === '[::1]' || h === '::1'
}
//! isBox — a bare host with no port: a DNS name or dotted IPv4 (labels of letters, digits and inner
// hyphens), or a bracketed IPv6. An all-digit entry is refused: it is a port missing its host, and a
// flag such as `--fero.heartbeat.ms` read off argv is not a host either.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
export const isBox = (h: unknown): h is string =>
  typeof h === 'string' && ((NAME.test(h) && !/^\d+$/.test(h)) || /^\[[0-9A-Fa-f:.]+\]$/.test(h))
//! canon — one spelling per host a dial lands on, so 'localhost', 'LOCALHOST', '0.0.0.0' and '127.0.0.1'
// read as one box: names are case-blind, and a wildcard dialed reaches loopback (a wildcard directory
// answers there too). '[::1]' stays apart from '127.0.0.1': two sockets, not one. An IPv4-mapped
// spelling is its IPv4 address: one socket (unmap).
const canon = (h: string): string => {
  const l = unmap(h).toLowerCase()
  return l === 'localhost' || l === '0.0.0.0' ? '127.0.0.1' : l === '::1' || l === '::' || l === '[::]' ? '[::1]' : l
}
//! boxDirectory — the directory address a bare host names, at this instance's rendezvous port
export const boxDirectory = (box: string, rendezvous: string): string => `${box}:${portOf(rendezvous)}`
//! sameDirectory — two directory addresses that dial the same socket (same port, same host after canon)
export const sameDirectory = (a: string, b: string): boolean => portOf(a) === portOf(b) && canon(hostOf(a)) === canon(hostOf(b))
//! fromBox — what another box's directory row may add to this instance's dial set. An address bound
// to loopback or a wildcard on THAT box would dial THIS box, so it is dropped — unless its host is
// the very host the directory was reached on (two loopback IPs standing for two boxes, as the tests
// do). The compose-time rule below keeps such addresses out of a reachable directory in the first
// place; this is the asking side's guard against a registrant composed elsewhere.
export const fromBox = (directory: string, row: Record<string, unknown>): string[] =>
  Object.values(row).filter((a): a is string => isAddr(a) && (!localish(hostOf(a)) || canon(hostOf(a)) === canon(hostOf(directory))))
//! leavesBox — the explicit-listen rule's trigger: why a server's listen would be handed to ANOTHER box,
// or null. Its directory answers other boxes (a rendezvous that is not loopback: other boxes ask it,
// and it hands them this server's listen), or its hosts name another box (with a port: a member there
// learns this listen from HELLO and gossips it; without one: it asks that box's directory and dials
// what it finds, with the same HELLO). Either way the listen must be an address another box can dial.
export const leavesBox = (rendezvous: string | false, hosts: readonly string[]): string | null => {
  if (rendezvous !== false && !loopbackHost(hostOf(rendezvous))) return `its directory ${rendezvous} answers other boxes`
  const far = hosts.find((h) => !localish(isAddr(h) ? hostOf(h) : h))
  return far === undefined ? null : `hosts names ${far}, another box`
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
export const afterFold = (fn: () => void): (() => void) => {
  let pending = false
  return () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; fn() }) }
}

//! GRACE — cleanup passes a never-published registrant survives before it is dropped: an entry whose
// caller was admitted (it registered) but has not yet appeared in a published `peers` row is in the
// HELLO→fold window, not dead; if it still is not up after this many passes, its link died inside
// that window and the entry would otherwise leak until the host dies.
export const GRACE = 3
//! WATCH_TICKS — the directory host's failure detector over client links (kernel/node.ts watchClients): a
// registrant's link that carries nothing for this many of the HOST's heartbeats is closed, and its entries go
// with it (the peer-down cleanup below). The host PINGs every client link every heartbeat and a live client
// answers on receipt, so silence this long is a hung process (stopped, its socket still open), not a slow
// one: 20 heartbeats is 10 s at the default 500 ms. A registrant that wakes up finds its link gone, redials
// and registers again.
export const WATCH_TICKS = 20
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
  // Entry lifetime IS the registrant's link: a crash or a clean close drops the socket at once, and a
  // hung-but-connected process loses its link after WATCH_TICKS silent host heartbeats (the host's
  // failure detector over client links). Runs on every host fold AND at the end of every register (see there).
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
      //! unregister — one instance leaving while its process's SHARED directory client stays (one client per
      // process, wave 5e): the link does not drop, so the peer-down cleanup cannot drop its entry. Only the
      // entry's CURRENT owner (the calling link) may remove it; anything else is a no-op that says false.
      unregister: (a: unknown, ctx: Context) => {
        const { name, uuid } = (a ?? {}) as { name?: unknown; uuid?: unknown }
        if (typeof name !== 'string' || typeof uuid !== 'string') throw new Error('unregister: name and uuid must be strings')
        if (ctx.peer === undefined || ctx.peer === selfOf()) throw new Error('unregister: only a directory client may unregister (no caller identity)')
        const k = key(name, uuid)
        if (owner.get(k) !== ctx.peer) return false
        owners.get(ctx.peer)?.delete(k)
        drop(k)
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

export interface BoxState { up: boolean; error?: string }
export interface DirectoryState { hosting: boolean; up: boolean; error?: string; boxes?: Record<string, BoxState> }

export interface DirectoryOpts {
  compose: Compose
  addr: string
  //! name/uuid/listen — the OWNING instance's identity; `listen` is undefined on a client (looks up,
  // never registers). Read lazily: a port-0 server's listen is known only after its runtime started.
  name: string
  uuid: string
  listen: () => string | undefined
  serve: boolean
  //! boxes — the directories of OTHER boxes this instance asks (bare `hosts` entries at the rendezvous
  // port, deduplicated, its own directory left out): lookup only, never register, never host
  boxes?: string[]
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

//! ── one directory client per process (wave 5e) ──
// Every instance in a process that meets the same directory, at the same heartbeat and redial, shares ONE
// `#directory` client and its link: N resources in one process cost the host one link, not N. Each instance
// still opens its own lookup on it, registers its own entry through it, and taps its link state. Counted by
// reference: the last instance to let go destroys it (its link drops, the host forgets what is left). An
// instance that lets go while others stay UNREGISTERS its entry, since the link stays up. Keyed by the compose
// seam too, so a test's stand-in compose never meets the composer's clients. Different heartbeat or redial
// settings get their own client: the client's cadence is the instance's failover speed.
interface Shared { key: string; pool: Map<string, Shared>; refs: number; client: Promise<Fero> }
const pools = new WeakMap<Compose, Map<string, Shared>>()
const share = (compose: Compose, key: string, make: () => Promise<Fero>): Shared => {
  let pool = pools.get(compose)
  if (pool === undefined) pools.set(compose, (pool = new Map()))
  let s = pool.get(key)
  if (s === undefined) {
    const made: Shared = { key, pool, refs: 0, client: make() }
    //! a compose that failed is no one's client: the next instance composes afresh
    made.client.catch(() => { if (pool!.get(key) === made) pool!.delete(key) })
    pool.set(key, (s = made))
  }
  s.refs++
  return s
}
//! unshare — let go; the last one out destroys the client
const unshare = async (s: Shared): Promise<void> => {
  if (--s.refs > 0) return
  if (s.pool.get(s.key) === s) s.pool.delete(s.key)
  const c = await s.client.catch(() => null)
  if (c !== null) await c.destroy()
}

export class Directory {
  #o: DirectoryOpts
  client: Fero | null = null
  host: Fero | null = null
  #destroyed = false
  #up = false
  //! #errs — the trouble each part reports, kept apart so one part's recovery never clears another's: a
  // successful register used to clear a lookup's error while that lookup stayed dead. `error` reads them
  // joined, bind first (a test and a screen key on the `bind ` prefix).
  #errs: { bind?: string; register?: string; lookup?: string } = {}
  #lastPeers = ''
  //! the re-subscribe timers of failed lookups (this box's and every asked box's), cleared on destroy
  #timers = new Set<NodeJS.Timeout>()
  //! this instance's hold on the process's shared clients (this box's, then each asked box's), and what it
  // attached to them — its taps and its lookups — undone on destroy, so a client that outlives the instance
  // carries nothing of it
  #own: Shared | null = null
  #held: Shared[] = []
  #undo = new Set<() => void>()
  #retry: NodeJS.Timeout | null = null
  #fails = 0
  //! the other boxes' directory clients (ask-only), their state, and every source's folded addresses
  // ('' = this box's directory, else the box directory's address)
  boxClients = new Map<string, Fero>()
  #boxes: Record<string, BoxState> = {}
  #rows = new Map<string, string[]>()
  #last = ''
  constructor(o: DirectoryOpts) {
    this.#o = o
    for (const b of o.boxes ?? []) this.#boxes[b] = { up: false }
  }
  get hosting(): boolean { return this.host !== null }
  get up(): boolean { return this.#up }
  get error(): string | undefined {
    const e = [this.#errs.bind, this.#errs.register, this.#errs.lookup].filter((x) => x !== undefined)
    return e.length === 0 ? undefined : e.join('; ')
  }
  //! boxes — a copy per read: cluster.me folds it into a proxy row
  get boxes(): Record<string, BoxState> | undefined {
    const ks = Object.keys(this.#boxes)
    return ks.length === 0 ? undefined : Object.fromEntries(ks.map((k) => [k, { ...this.#boxes[k] }]))
  }
  #state(): DirectoryState { const error = this.error; return { hosting: this.hosting, up: this.#up, ...(error !== undefined ? { error } : {}), ...(this.boxes ? { boxes: this.boxes } : {}) } }
  #setError(kind: 'bind' | 'register' | 'lookup', e: string | undefined) {
    if (e === this.#errs[kind]) return
    if (e === undefined) delete this.#errs[kind]
    else this.#errs[kind] = e
    this.#o.onState(this.#state())
  }
  #setBox(addr: string, up: boolean, error: string | undefined) {
    const b = this.#boxes[addr]
    if (b.up === up && b.error === error) return
    this.#boxes[addr] = { up, ...(error !== undefined ? { error } : {}) }
    this.#o.onState(this.#state())
  }
  //! #publish — one source's addresses changed: the union over every source, minus own listen, posts
  // as ONE discover when it differs from the last one posted
  #publish(source: string, addrs: string[]) {
    if (this.#destroyed) return
    this.#rows.set(source, addrs)
    const me = this.#o.listen()
    const hosts = [...new Set([...this.#rows.values()].flat().filter((a) => a !== me))].sort()
    const key = hosts.join(',')
    if (key === this.#last) return
    this.#last = key
    this.#o.onHosts(hosts)
  }
  //! #share — this process's `#directory` client for `addr`, shared with every other instance here that
  // meets it at the same settings; composed by the first, with the I-19 guard
  #share(addr: string): Shared {
    const o = this.#o
    const s = share(o.compose, `${addr}|${o.heartbeatMs}|${o.redialMs ?? ''}`, () => this.#client(addr))
    this.#held.push(s)
    return s
  }
  //! #tap — a tap on a shared client's proxy, removed when this instance goes
  #tap(target: { tap: (fn: () => void) => unknown }, fn: () => void): void {
    const t = target.tap(fn) as { dispose?: () => void }
    this.#undo.add(() => t.dispose?.())
  }
  //! #client — compose one `#directory` client dialing `addr`, with the I-19 guard
  async #client(addr: string): Promise<Fero> {
    const o = this.#o
    const c = await o.compose(DIRECTORY, { hosts: [addr], heartbeat: { ms: o.heartbeatMs }, ...(o.redialMs !== undefined ? { redial: { ms: o.redialMs } } : {}) }, true)
    //! I-19's guard: a client's `methods` hands out a handle maker for ANY name, so `lookup` is not a function
    // only when this compose came back as something else (a server's methods are its own table). Not
    // reproduced (30/30 and the host-death race test green), so if it ever recurs, say the cause.
    if (typeof (c.methods as Record<string, unknown>).lookup !== 'function') {
      const role = (snapshot(c.cluster) as { me?: { role?: string } }).me?.role ?? 'non-client'
      await c.destroy()
      throw new Error(`#directory: the directory client composed as a ${role} — its methods have no lookup (I-19)`)
    }
    return c
  }

  //! start — (servers) one bind attempt first, so a fresh box gets its directory on the first server
  // with no round trip; then the client, its registration on every primary, and the live lookup.
  async start(): Promise<void> {
    if (this.#o.serve) await this.#tryHost()
    if (this.#destroyed) return
    const o = this.#o
    this.#own = this.#share(o.addr)
    const c = await this.#own.client
    if (this.#destroyed) return // destroy() lets go of the share
    this.client = c
    //! a server that lost the first bind (another host, or a squatter) starts the retry loop NOW — the
    // link-down transition below never fires for a directory that was never up
    if (o.serve && !this.hosting) this.#armRetry()
    //! the directory link, from the client's own cluster fold (read after the fold): up ⇒ (servers)
    // register on THIS primary; down ⇒ (servers) start the bind-retry loop. The peers key changes on
    // every primary change, so a takeover (new host uuid) re-registers even without an observed gap.
    this.#tap(c.cluster, afterFold(() => {
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
    this.#lookup(c, '', (row) => Object.values(row).filter((a) => typeof a === 'string'), (e) => this.#setError('lookup', e))
    //! the other boxes (§11): one ask-only client each, after this box's own
    for (const b of o.boxes ?? []) {
      if (this.#destroyed) return
      await this.#ask(b)
    }
  }

  //! #ask — another box's directory: look the name up there, fold what that box may add (fromBox), and
  // keep its up/error on cluster.me.rendezvous.boxes. Never registers (this server's listen is published
  // by its OWN box's directory), never hosts (that socket is on another box). An unreachable box is a
  // link that redials like any other; a misdial onto a non-directory is refused by the HELLO name echo.
  async #ask(addr: string): Promise<void> {
    const c = await this.#share(addr).client
    if (this.#destroyed) return
    this.boxClients.set(addr, c)
    let lastPeers = ''
    this.#tap(c.cluster, afterFold(() => {
      if (this.#destroyed) return
      const peers = (snapshot(c.cluster) as { peers: Peers }).peers ?? {}
      const key = Object.keys(peers).filter((u) => peers[u].up).sort().join(',')
      if (key === lastPeers) return
      lastPeers = key
      this.#setBox(addr, key !== '', this.#boxes[addr].error)
    }))
    //! `error` is a failed lookup; it stays set while the lookup is dead, even when the link comes back
    // (that would read a dead lookup as a healthy box), and clears only when the lookup itself recovers
    this.#lookup(c, addr, (row) => fromBox(addr, row), (e) => this.#setBox(addr, this.#boxes[addr].up, e))
  }

  //! #lookup — one live lookup of this instance's name on directory client `c`, its folded addresses posted as
  // `source`. A failed lookup (the host's handler threw, on the first host or on a later one after a takeover)
  // is the directory's trouble, not the server's: `onError` hears it, so it shows as `error` instead of
  // exiting the process as an unhandled `ready` rejection would. The Caller drops a failed sub for good
  // (api/methods.ts, Caller.#fail), so the lookup is opened again here, after a jittered delay that doubles
  // per consecutive failure to the cap (the bind-retry loop's numbers): a host whose lookup throws every time
  // costs one call every few seconds. A re-subscribe while the link is down is held and replayed on the next
  // primary, like any sub. `error` clears only on the FIRST FRAME of a lookup opened after the failure — the
  // lookup itself recovered — never because some other part of the directory succeeded.
  #lookup(c: Fero, source: string, fold: (row: Row) => string[], setErr: (e: string | undefined) => void, fails = 0): void {
    if (this.#destroyed) return
    let failed = false
    //! undo — this lookup's tap and its sub on the shared client: run on destroy, or when a failed lookup is
    // opened again (the failed sub is already gone from the Caller; its tap is not)
    let t: { dispose?: () => void } | undefined
    const h = c.methods.lookup(this.#o.name, { onError: (e: Error) => onError(e) }) as { tap: (fn: () => void) => unknown; ready: Promise<void>; close: () => void }
    const undo = () => { t?.dispose?.(); h.close() }
    this.#undo.add(undo)
    const onError = (e: Error) => {
      if (this.#destroyed || failed) return
      failed = true
      setErr(`lookup: ${e?.message ?? String(e)}`)
      const delay = Math.min(RETRY_CAP, (RETRY_BASE + Math.floor(Math.random() * 4 * RETRY_BASE)) * 2 ** Math.min(fails, 8))
      const r = setTimeout(() => {
        this.#timers.delete(r)
        this.#undo.delete(undo); undo()
        this.#lookup(c, source, fold, setErr, fails + 1)
      }, delay)
      r.unref?.()
      this.#timers.add(r)
    }
    t = h.tap(afterFold(() => {
      if (this.#destroyed) return
      this.#publish(source, fold((snapshot(h) as Row | undefined) ?? {}))
    })) as { dispose?: () => void }
    //! the first frame of THIS lookup: it is alive, so any lookup error before it is over (the opening
    // lookup's first frame clears nothing: no error was set yet)
    h.ready.then(() => { if (!this.#destroyed && !failed) setErr(undefined) }, () => {})
  }

  //! #register — idempotent, re-issued on every primary; a host REFUSAL is deterministic (bad listen,
  // the per-caller cap) so it is surfaced on cluster.me.rendezvous.error rather than retried blindly
  async #register(): Promise<void> {
    const c = this.client
    const listen = this.#o.listen()
    if (!c || !this.#o.serve || listen === undefined) return
    try {
      await (c.methods.register as (a: unknown, o?: unknown) => Promise<unknown>)({ name: this.#o.name, uuid: this.#o.uuid, listen }, { retry: true, timeout: 5000 })
      this.#setError('register', undefined)
    } catch (e) {
      if (!this.#destroyed) this.#setError('register', `register: ${(e as Error)?.message ?? String(e)}`)
    }
    //! a register that settled after this instance stopped (held while the link was down and replayed on the
    // next primary, or one that timed out here but still landed) may have put the entry back: take it out
    // again. A no-op when the client went with its last user (its link drop cleans the host up).
    if (this.#destroyed) void this.#unregister(c).catch(() => {})
  }

  //! #unregister — take this instance's entry out through the shared client. Owner-only and idempotent at the
  // host, so it needs no "registered yet?" gate. `retry`: a call held while the link is down, or shipped and lost
  // with a dying primary, is sent again on the next primary — AFTER any register sent before it, since the
  // Caller replays in call order — so an entry can never land after the unregister that should remove it.
  //! async: a client already destroyed may throw at the call, and that must stay a rejection here
  async #unregister(c: Fero): Promise<unknown> {
    return await (c.methods.unregister as (a: unknown, o?: unknown) => Promise<unknown>)({ name: this.#o.name, uuid: this.#o.uuid }, { retry: true, timeout: 5000 })
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
    if (code !== null) { this.#fails++; if (code !== 'EADDRINUSE') this.#setError('bind', `bind ${o.addr}: ${code}`); return }
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
      delete this.#errs.bind
      this.#o.onState(this.#state())
    } catch (err) {
      this.#fails++
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== undefined && code !== 'EADDRINUSE') this.#setError('bind', `bind ${o.addr}: ${code}`)
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

  //! destroy — this instance's entry first: unregistered when the process's shared client stays up for
  // others (the link does not drop, so nothing else would drop it), or gone with the link when this was the
  // client's last user. Then its taps and lookups come off the shared clients, it lets go of them (the last
  // one out destroys each), and last the hosted directory if this instance holds it (⇒ every other
  // server's retry loop races for the port). A #tryHost in flight sees #destroyed and destroys what it built.
  async destroy(): Promise<void> {
    this.#destroyed = true
    this.#stopRetry()
    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()
    const c = this.client; this.client = null
    //! ALWAYS sent when the shared client stays (a server only: a client never registers), whatever this
    // instance believes about its register: one may still be in flight (fero() resolves before it comes back)
    // or held for the next primary, and either lands BEFORE this unregister — same link, call order. Awaited
    // only while the link is up, and then bounded at 2 s; while it is down the Caller holds it for the next
    // primary and the stop does not wait. A host from before wave 5e has no unregister — the entry then lives
    // until the shared client's link drops, as every entry did before.
    if (c !== null && this.#o.serve && this.#own !== null && this.#own.refs > 1) {
      const gone = this.#unregister(c).catch(() => {})
      if (this.#up) {
        let t: NodeJS.Timeout | undefined
        await Promise.race([gone, new Promise<void>((r) => { t = setTimeout(r, 2000); t.unref?.() })])
        clearTimeout(t)
      }
    }
    for (const u of this.#undo) { try { u() } catch {} }
    this.#undo.clear()
    this.boxClients.clear()
    const held = this.#held; this.#held = []; this.#own = null
    await Promise.allSettled(held.map(unshare))
    const h = this.host; this.host = null
    if (h) await h.destroy()
  }
}
