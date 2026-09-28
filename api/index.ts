//! ── api/index — the composer: fero(name, opts) → { name, data, methods, cluster, snapshot, destroy } ──
// The whole public surface (plan §9, the v2 shape kept): zero events, zero hooks —
// everything reactive is a ViewProxy you connect or tap. Config recognition is by
// DECLARED KEY: every option must be a known FeroConfig key, typos throw at fero()
// time, and hosted methods live under `methods:` — whose presence is THE DOOR (V4-5:
// clients change a protected resource only through its methods). Function-valued
// CONFIG lives under the one reserved `seams` key.
//
// M5a scope: the server/solo composer over the shell Runtime — data binding both
// directions with the write-route join (api/data.ts; V4-7: a write shows when it commits), the default write methods with
// {confirm, timeout} against the M4c guarantee ladder, restore-before-network when
// `dir` holds a previous life, and a minimal reactive cluster surface. The client
// role (M5b) and user-method dispatch (M5c) land next.

import { randomUUID } from 'node:crypto'
import { Runtime, restoreOpts, type RuntimeOpts } from '../shell/runtime.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { REC, partitionOf, type Rec } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { Bind, type Coords } from './data.ts'
import { Caller, Host, SYSTEM, handle, type Context } from './methods.ts'
import { Gather, rowsPartial, liveCadence, type Rows } from './fold.ts'
import { proxy, contract, batch, snapshot as snapshotOf } from './substrate.ts'
import { diagnostics, type Diagnostics } from './diagnostics.ts'
import { Directory, DIRECTORY, RENDEZVOUS, isAddr, rendezvousDefault, sameSocket } from './directory.ts'
import { resolveConfig, src, CONFIG_LEAVES } from './config.ts'
import { compact, frontier, gcTombstones } from '../kernel/log.ts'
import { captureNode } from '../tools/debug/capture.ts'
import { track, untrack } from './signals.ts'
import { spawn } from './spawn.ts'
import type { Change, Fero, FeroOpts, Guarantee, Methods, WriteOpts, WriteReject, WriteResolve } from './types.ts'

//! the declared config schema: PICKED keys, everything else is a loud error (plan §9)
const CONFIG_KEYS = new Set(['uuid', 'server', 'listen', 'hosts', 'dir', 'heartbeat', 'redial', 'journal', 'replicas', 'data', 'methods', 'seams', 'rendezvous', 'signals'])
const SEAM_KEYS = new Set(['validation'])

//! METHODS_ONLY — the terminal reason a protected server gives a client's plain write (V4-5): it rides
// V4-4's `invalid` WNACK as `m`, surfaces as WriteReject.reason and cluster.writes.reason, and is what a
// plain client assignment is refused with (nothing ever showed — V4-7). A degenerate admission predicate
// folded into the ONE kernel hook.
export const METHODS_ONLY = 'methods-only'
const METHODS_ONLY_ADMIT = (_: Rec): true | string => METHODS_ONLY

//! WriteRejectError — what methods.update/insert/remove REJECT with: the typed WriteReject fields riding
// on an Error. A bare object died as one line when uncaught — `{ guarantee: 'committed', reached:
// 'issued', reason: 'timeout' }` — no stack, no verb, no resource, and no hint that the reader forgot
// `server: true`. The message names them all: `fero('shop') update ["x"]: timeout after 10000ms —
// reached issued (nobody to write to: …)`. The fields are OWN enumerable properties and `name` sits on
// the prototype, so `{ ...e }` is exactly the WriteReject, `e.reason` reads as before, and every
// `satisfies WriteReject` consumer keeps working.
export class WriteRejectError extends Error implements WriteReject {
  declare guarantee: Guarantee
  declare reached: 'issued' | 'committed'
  declare reason: string
  declare localCommit?: { origin: string; seq: number; epoch: number }
  constructor(fields: WriteReject, message: string) {
    super(message)
    Object.assign(this, fields)
  }
}
Object.defineProperty(WriteRejectError.prototype, 'name', { value: 'WriteRejectError', configurable: true, writable: true })
//! VERB_NAMES — REC type → the methods.* verb a message names
const VERB_NAMES = ['update', 'insert', 'remove'] as const

//! discovery (V4-3, DESIGN-DIRECTORY.md): no name hashing — a server binds a FREE loopback port and
// registers {name, uuid, listen} with the per-box directory (api/directory.ts, the `#directory`
// system resource at the rendezvous address); everyone looks the name up LIVE and the addresses feed
// the kernel's dial set through the `discover` event. Zero addresses configured, zero collisions.
export { RENDEZVOUS, DIRECTORY } from './directory.ts'

//! keyPath — normalize the Change.key sugar: 'user42' and ['user42','active'] are both paths.
const keyPath = (k: string | string[] | undefined): string[] =>
  k === undefined ? [] : Array.isArray(k) ? k.map(String) : [String(k)]

export const fero = (name: string, opts: FeroOpts = {}): Promise<Fero> => compose(name, opts, false)
//! fero.spawn(file, args?, opts?) (V4-9): `node <file> …` as a separate process — the reader's other terminal, from code (api/spawn.ts)
fero.spawn = spawn

//! compose — the composer proper. `system` admits a `#`-prefixed name (the directory) and skips the
// directory for the instance itself (a directory never meets a directory); the public fero() always
// passes false — the # prefix can never be taken by accident.
const compose = async (name: string, opts: FeroOpts, isSystem: boolean): Promise<Fero> => {
  if (typeof name !== 'string' || name === '') throw new Error(`fero(${JSON.stringify(name)}): name must be a non-empty string`)
  if (!isSystem && name.startsWith('#')) throw new Error(`fero('${name}'): names starting with # are reserved for system resources (${DIRECTORY})`)
  //! every option is a DECLARED key (V4-5): a function-valued option is the pre-V4-5 method spelling —
  // refused with the pointer (moving it under `methods:` also declares the door, on purpose)
  for (const [k, v] of Object.entries(opts as Record<string, unknown>))
    if (typeof v === 'function' && k !== 'methods') // `methods: fn` gets the plain-object message below, not a pointer to methods: { methods }
      throw new Error(`fero('${name}'): '${k}' is a function — methods live under methods: { ${k} }, and declaring them makes clients change data only through them`)
  //! the six layers fold into the call HERE (V4-10, api/config.ts): a launch flag, the call, the
  // environment, a fero.opt.ts at the project or in $HOME — checked against the declared schema and
  // coerced before anything below reads them. A system resource gets the explicit opts the composer
  // handed it. `from(key)` names the layer behind a value; `at(key)` is its suffix for a message.
  const resolved = isSystem ? { config: opts, from: () => 'the call' } : resolveConfig(name, opts)
  const from = resolved.from
  const at = (key: string): string => src(from(key))
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved.config as Record<string, unknown>)) {
    if (!CONFIG_KEYS.has(k)) throw new Error(`fero('${name}'): unknown option '${k}' — config keys are ${[...CONFIG_KEYS].join(', ')}`)
    if (v !== undefined) config[k] = v
  }
  if (config.signals !== undefined && typeof config.signals !== 'boolean') throw new Error(`fero('${name}'): signals must be true or false (false = leave Ctrl-C / SIGTERM to you)`)
  //! methods: — the hosted methods AND the door (V4-5). Validated as a whole at fero() time: a PLAIN
  // object of functions (own enumerable handlers — a class instance keeps its methods on the prototype,
  // would host nothing and protect everything: refused here, not discovered by clients at runtime);
  // names off the system plane and off the built-in writers.
  const m = config.methods
  const plain = typeof m === 'object' && m !== null && !Array.isArray(m) && (Object.getPrototypeOf(m) === Object.prototype || Object.getPrototypeOf(m) === null)
  if (m !== undefined && !plain)
    throw new Error(`fero('${name}'): methods must be a plain object of handlers — methods: { sell(arg, ctx) { … } } (own functions, not a class instance) — its presence makes the resource protected (clients change data only through them)`)
  const userMethods = (config.methods ?? {}) as Record<string, (...args: unknown[]) => unknown>
  for (const [k, v] of Object.entries(userMethods)) {
    if (typeof v !== 'function') throw new Error(`fero('${name}'): methods.${k} must be a function (arg, ctx) => …`)
    if (k.startsWith(SYSTEM)) throw new Error(`fero('${name}'): method names may not start with \\u0000 (reserved for the system plane)`)
    if (k === 'update' || k === 'insert' || k === 'remove') throw new Error(`fero('${name}'): methods.${k} is a built-in writer — wrap it via seams.validation or name the method differently`)
  }
  const methodsOnly = config.methods !== undefined
  const seams = (config.seams ?? {}) as Record<string, unknown>
  for (const k of Object.keys(seams))
    if (!SEAM_KEYS.has(k)) throw new Error(`fero('${name}'): unknown seam '${k}' — M5a ships ${[...SEAM_KEYS].join(', ')}; hash/codec/storage land with their milestones`)

  //! role by DECLARED ACT (v4.1 — supersedes the v2 hosts-without-listen rule): following is the
  // ambient case, serving is a declared act. Any server MARKER makes a server — server: true, listen
  // (an address, or false = the socketless solo), dir (durability), replicas (scoping), a `data`
  // seed, or `methods:` (hosted methods — and the door, V4-5). No marker = a CLIENT: a spoke dialing
  // its hosts — or, bare, the name-derived local port. `hosts` is pure dial targets now: alone it
  // keeps the v2 client shape; beside a marker it makes a dialing member (listen+hosts, unchanged).
  // Role is a pure function of the CONFIG — never of timing, launch order, or who answers a dial.
  if (config.server !== undefined && typeof config.server !== 'boolean')
    throw new Error(`fero('${name}'): server must be true (pin the server role) or false (pin the client role)${at('server')} — omit it and a bare fero is a client`)
  if (config.listen !== undefined && config.listen !== false && !isAddr(config.listen, true))
    throw new Error(`fero('${name}'): listen must be a 'host:port' string (a non-empty host; port 0 = a free port), or false for a socketless solo node${at('listen')}`)
  if (config.hosts !== undefined && !Array.isArray(config.hosts))
    throw new Error(`fero('${name}'): hosts must be an array of 'host:port' strings${at('hosts')}`)
  //! every entry is checked as an ADDRESS and the bad one is NAMED: a role file that reads its ports off
  // process.argv and is launched with a `--fero.<key>` flag used to build '127.0.0.1:--fero.heartbeat.ms'
  // and die deep in the shell on Node's raw `Port should be >= 0 and < 65536` (rungs 15 and 16)
  if (config.hosts !== undefined) {
    const i = (config.hosts as unknown[]).findIndex((h) => !isAddr(h))
    if (i !== -1) {
      const h = (config.hosts as unknown[])[i]
      throw new Error(`fero('${name}'): hosts[${i}] ${typeof h === 'string' ? `'${h}'` : String(h)} is not a 'host:port' address${at('hosts')}`)
    }
  }
  if (config.dir !== undefined && (typeof config.dir !== 'string' || config.dir === ''))
    throw new Error(`fero('${name}'): dir must be a non-empty path${at('dir')}`)
  const plainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  if (config.data !== undefined && !plainObject(config.data))
    throw new Error(`fero('${name}'): data must be a plain object of initial rows — it seeds the resource only when the local fold is empty at boot${at('data')}`)
  //! server: false (V4-10) is the CLIENT pin: with the layers, a server marker can now arrive from a flag,
  // a variable or a file — a process that means to follow refuses every marker, naming it and its source
  if (config.server === false) {
    const marker = (['listen', 'dir', 'replicas', 'data', 'methods'] as const).find((k) => config[k] !== undefined)
    if (marker !== undefined)
      throw new Error(`fero('${name}'): server: false pins the client role${at('server')}, but '${marker}' makes a server${at(marker)} — drop one`)
  }
  const isServer = config.server === true || config.listen !== undefined || config.dir !== undefined
    || config.replicas !== undefined || config.data !== undefined || methodsOnly
  const isClient = !isServer
  //! an undialable member is refused loudly: a socketless node cannot be dialed back, heartbeated,
  // or counted by genesis — the v2 rule ("a spoke that can never be dialed can never be a member")
  // survives as a validation instead of a role inference
  if (config.listen === false && Array.isArray(config.hosts) && (config.hosts as string[]).length > 0)
    throw new Error(`fero('${name}'): an undialable node (listen: false) cannot join a cluster — give it a listen address or drop hosts`)
  if (config.replicas !== undefined && (!Number.isInteger(config.replicas) || (config.replicas as number) < 1))
    throw new Error(`fero('${name}'): replicas must be an integer ≥ 1 (omit for full replication)${at('replicas')}`)
  //! the timing and bound keys (V4-10 nested spelling): a string layer can now carry a non-number —
  // checked here, because `('abc' ?? 0) > 0` in the kernel would silently turn heartbeats off
  const num = (key: string, v: unknown, min: number, int: boolean, what: string): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (int && !Number.isInteger(v)))
      throw new Error(`fero('${name}'): ${key} must be ${what}${at(key)}`)
    return v
  }
  const group = (k: 'heartbeat' | 'redial' | 'journal'): Record<string, unknown> => {
    const g = config[k]
    if (g === undefined) return {}
    if (typeof g !== 'object' || g === null || Array.isArray(g)) throw new Error(`fero('${name}'): ${k} is a group — ${k}: { ${k === 'journal' ? 'cap' : 'ms'}: … }${at(k)}`)
    return g as Record<string, unknown>
  }
  const heartbeatMs = num('heartbeat.ms', group('heartbeat').ms, 0, false, 'a finite number of milliseconds ≥ 0 (0 = heartbeats off)')
  const redialMs = num('redial.ms', group('redial').ms, 0, false, 'a finite number of milliseconds ≥ 0')
  const journalCap = num('journal.cap', group('journal').cap, 1, true, 'an integer ≥ 1')
  //! the rendezvous (V4-3): the per-box directory this instance meets at — precedence: `rendezvous:`
  // config > FERO_RENDEZVOUS (an address, or 'off') > the constant; false = no directory. A system
  // resource meets none. A malformed env value is refused HERE, loudly, not deep in the shell.
  if (config.rendezvous !== undefined && config.rendezvous !== false && !isAddr(config.rendezvous))
    throw new Error(from('rendezvous') === 'FERO_RENDEZVOUS'
      ? `fero('${name}'): FERO_RENDEZVOUS='${process.env.FERO_RENDEZVOUS}' is not a 'host:port' address (or 'off')`
      : `fero('${name}'): rendezvous must be a 'host:port' string (port 1–65535), or false for no directory${at('rendezvous')}`)
  const envDefault = config.rendezvous === undefined && !isSystem ? rendezvousDefault() : false
  if (envDefault !== false && !isAddr(envDefault))
    throw new Error(`fero('${name}'): FERO_RENDEZVOUS='${process.env.FERO_RENDEZVOUS}' is not a 'host:port' address (or 'off')`)
  const rendezvous: string | false = isSystem ? false : ((config.rendezvous as string | false | undefined) ?? envDefault)
  //! the effective topology: a server without an address binds a FREE loopback port (the OS picks,
  // the directory publishes it) — the demo's two terminals need zero addresses, real deployments keep
  // explicit ones; a bare client dials whatever the directory lists for the name
  const listen = isServer && config.listen !== false ? ((config.listen as string | undefined) ?? '127.0.0.1:0') : undefined
  const hosts = config.hosts as string[] | undefined
  //! a user resource may not listen ON a rendezvous socket — its own, the process default's, or the
  // constant's — under ANY spelling that lands on the same loopback socket (`0.0.0.0:3376`,
  // `localhost:3376`, `[::]:3376` all bind what 127.0.0.1:3376 dials): every directory client on the
  // box would name-reject it. The kernel now revives a name-rejected target at heartbeat cadence, so
  // a squat is a heartbeat-bounded nuisance rather than a strand — but a resource that CANNOT be
  // found by anyone is a misconfiguration worth refusing at fero() time.
  if (!isSystem && listen !== undefined) {
    const taken = [rendezvous, envDefault, RENDEZVOUS].find((rz) => rz !== false && sameSocket(listen, rz))
    if (taken !== undefined)
      throw new Error(`fero('${name}'): listen ${listen} would take the directory's socket (${taken}) — pick another port, or move the directory with rendezvous:`)
  }
  //! the default listen is a LOOPBACK convenience: gossiping 127.0.0.1 as "my dialable address" to a
  // non-local peer would have every dial-back reach the peer's OWN box — a futile redial forever, or
  // a same-named stranger silently welded into membership. Dialing past loopback demands explicit listen.
  const loopback = (h: string) => h.startsWith('127.') || h.startsWith('localhost:') || h.startsWith('[::1]')
  if (isServer && config.listen === undefined && hosts !== undefined && hosts.some((h) => !loopback(h)))
    throw new Error(`fero('${name}'): explicit listen required when dialing non-local hosts — the default listen is a free loopback port (peers would be told 127.0.0.1 is this node's address)`)
  //! uuid discipline (v4.1): the string is validated (an empty uuid, or one containing '~' — the
  // incarnation-lane separator — could alias another node's lane in origin-string space), and a
  // durable dir's RESTORED identity beats the random default: fero(name, {dir}) with uuid omitted
  // boots as the SAME node every life. A user-supplied uuid that contradicts the dir throws loudly —
  // adopting a foreign log under a new name is the silent evicted-heir bug, never a default.
  const badUuid = (u: unknown) => typeof u !== 'string' || u === '' || u.includes('~')
  if (config.uuid !== undefined && badUuid(config.uuid))
    throw new Error(`fero('${name}'): uuid must be a non-empty string without '~' (the incarnation-lane separator)${at('uuid')}`)
  //! restore-before-network: a dir holding a previous life boots as its heir (identity recovered,
  // incarnation bumped, clock leased, votedFor honored) — the composer makes the wal.test.ts idiom
  // the default path
  const restored = config.dir ? restoreOpts(config.dir as string) : {}
  //! the review's legacy-poisoning finding: a pre-v4.1 boot record carries no uuid — letting the
  // RANDOM default claim such a dir would stamp the accident into boot.json on the very next write
  // and lock the true owner out behind the mismatch throw below. Refuse instead: the operator names
  // the identity ONCE; every later boot record carries it and recovery is automatic thereafter.
  if (restored.boot !== undefined && restored.uuid === undefined && config.uuid === undefined)
    throw new Error(`fero('${name}'): this dir predates identity recovery (a v4.0 boot record carries no uuid) — pass the node's uuid once; the next boot record will carry it`)
  //! a hand-edited or embedder-written boot record gets the SAME validation as config (the composer
  // is the public gate; the kernel trusts NodeOpts by design)
  if (restored.uuid !== undefined && badUuid(restored.uuid))
    throw new Error(`fero('${name}'): this dir's boot record carries an invalid uuid (${JSON.stringify(restored.uuid)}) — repair boot.json`)
  if (config.uuid !== undefined && restored.uuid !== undefined && config.uuid !== restored.uuid)
    throw new Error(`fero('${name}'): uuid '${config.uuid as string}'${at('uuid')} does not match this dir's previous life '${restored.uuid}' — one dir, one identity (use a fresh dir for a new node)`)
  //! the dir records WHAT as well as WHO (v4.1): the same misdial class the name-echo closes on the
  // wire exists one layer down — fero('other', {dir-of-'r'}) would fold r's WAL into 'other' and
  // replicate it outward. A legacy record lacks the field: no check, stated legacy behavior.
  if (restored.name !== undefined && restored.name !== name)
    throw new Error(`fero('${name}'): this dir belongs to resource '${restored.name}' — one dir, one resource (use a fresh dir)`)
  //! (after identity validation: a bad uuid is the earlier, more specific error) a client with nothing to dial is a dead-end — refuse loudly rather than boot a follower that can
  // never follow anything: no directory (rendezvous: false / FERO_RENDEZVOUS=off) AND no hosts
  if (isClient && rendezvous === false && (hosts === undefined || hosts.length === 0))
    throw new Error(`fero('${name}'): a client needs something to dial — the directory is off (rendezvous: false) and hosts is ${hosts === undefined ? 'omitted' : 'empty'}`)
  const rtOpts: RuntimeOpts = {
    uuid: (config.uuid as string) ?? restored.uuid ?? randomUUID().slice(0, 8),
    //! the resource name rides HELLO (v4.1): a misdial onto another resource's port refuses loudly
    // (JK.nameReject) instead of silently cross-replicating two unrelated logs
    name,
    listen,
    hosts,
    client: isClient || undefined,
    dir: config.dir as string | undefined,
    //! the KERNEL keeps heartbeats explicit (0 = off, the sweep mode); the COMPOSER is where production
    // defaults live: 500ms drives genesis/suspicion on servers and the write-retry clock + AE floor on
    // clients. Pass heartbeat: { ms: 0 } to opt out.
    heartbeatMs: heartbeatMs ?? 500,
    redialMs,
    journalCap,
    ...(config.replicas !== undefined ? { replicas: config.replicas as number } : {}),
    //! the relay's admission predicate (V4-4, V4-5): a client's plain write relayed through this server
    // meets the kernel's relay ingress (kernel/write.ts onWrite) with THIS predicate — under `methods:`
    // the door itself (every relayed record refused 'methods-only', before any user code runs);
    // otherwise the server's seams.validation, exactly as for its own issues; otherwise nothing (open —
    // the relay loop is the pre-V4-4 loop). Zero kernel change for the door: it is what the composer puts
    // INTO the one hook. Inert on a client (nobody relays through a spoke).
    ...(methodsOnly ? { validate: METHODS_ONLY_ADMIT }
      : seams.validation !== undefined ? { validate: seams.validation as (rec: Rec) => true | string } : {}),
    ...(restored.boot !== undefined ? { boot: restored.boot } : {}),
    ...(restored.incarnation !== undefined ? { incarnation: restored.incarnation } : {}),
  }
  const rt = new Runtime(rtOpts)
  //! the binding wires rt.onApply BEFORE restore, so the WAL replay refills the proxy. `tracked` is
  // late-bound to the method host (flush-on-return attribution — api/methods.ts).
  let host: Host | null = null
  const bind = new Bind(rt, {
    validate: seams.validation as ((rec: Rec) => true | string) | undefined,
    tracked: () => host?.tracked(),
  })
  if (config.dir) rt.restore()

  //! ── the confirm-probe multiplexer (M4c events under the methods surface) ──
  let probeSeq = 0
  const probes = new Map<number, (ok: boolean) => void>()
  rt.onConfirm = (id, ok) => { probes.get(id)?.(ok); probes.delete(id) }
  const probe = (c: Coords, level: number, ms: number, part?: string): Promise<boolean> =>
    new Promise((resolve) => {
      const id = ++probeSeq
      const t = setTimeout(() => {
        if (!probes.delete(id)) return
        rt.node.step({ kind: 'confirmCancel', id })
        resolve(false)
      }, ms)
      t.unref?.()
      probes.set(id, (ok) => { clearTimeout(t); resolve(ok) })
      rt.node.step({ kind: 'confirm', id, origin: c.origin, seq: c.seq, level, part })
    })

  //! ── the method plane (M5c): every node HOSTS (servers get invokes; a spoke none), clients CALL ──
  //! M6: scoped servers get a MEMBER caller (rpc `to` routing) — the gather's fan-out and the
  // non-held remote read ride the same method plane a client uses; one Caller per node either way.
  const node = rt.node
  const scoped = !isClient && typeof config.replicas === 'number'
  const memberCaller = scoped ? new Caller(rt) : null
  //! the gather (M6, DESIGN-M6 C5): whole-resource read() under scoping — memoized, ONE per node,
  // and LAZY (M6-review finding 41): constructed on FIRST consumption (read() / `await data`), so a
  // scoped server whose union nobody ever reads never fans out N² full-claims downloads on view
  // installs — the install-triggered refresh below fires only once `gather` is non-null.
  let gather: Gather | null = null
  const gatherOf = (): Gather =>
    (gather ??= new Gather(rt, (uuid, t) => memberCaller!.call(SYSTEM + 'rows', undefined, { timeout: t, to: uuid }) as Promise<Rows>))

  //! ── the scoped data facade (M6, DESIGN-M6 C6): §9's promise — an expression means the same at
  // R=2 and R=∞, TYPED ERRORS, never a silent partial. Operators would fold the held SHARD as if it
  // were the resource: they throw ScopedError with the materialize-first hint (the distributed
  // decomposable folds are deferred by de-scoping rung 2 — recorded at slice 5). `await data` routes
  // through the gather; a non-held key access returns a typed one-shot remote handle (await = the
  // owner's value); held keys and writes pass straight through to the raw proxy. Built BEFORE the
  // Host so handlers receive it as ctx.data (M6-review finding 4 — see below).
  //! the operator set comes from data's exportContract() (DESIGN-DATA3 W17 promise: fero
  // deletes its hand-copied operator lists — drift with data's registry is now impossible)
  const OPERATORS = new Set(Object.keys(contract().operators))
  const scopedThrow = (op: string, reason: 'holistic' | 'shortfall', hint: string, partition?: string): never => {
    throw { scoped: true, op, reason, replicas: node.replicas, ...(partition !== undefined ? { partition } : {}), hint } satisfies import('./types.ts').ScopedError
  }
  //! keyedRead — the ONE keyed-read routing every internal path shares (the remote-key handle, the
  // built-in read's non-held leg, the SYSTEM-plane hop). M6-review finding 5: the hop dispatches
  // SYSTEM + 'read', never the user-claimable 'read' name — a user-supplied `read` method can no
  // longer intercept `await data.<key>` or the owner-routed keyed read. M6-review finding 15: when
  // THIS node is the resolved owner but the entry is still ACQUIRING (state 2), the raw base would
  // answer a silent undefined (§9's banned answer) — defer on a short poll (the handover is
  // heartbeat-paced) until the entry leaves acquiring, bounded at ~2s, then serve; past the bound,
  // typed shortfall with the retry hint. The handler always runs on the resolved owner, so this one
  // guard site covers the local first-hop and the remote answer alike.
  const keyedRead = async (k: string): Promise<unknown> => {
    if (scoped && node.armed && !node.scope!.held(k)) {
      //! the ring must be BUILT for the committed epoch before ownerOf answers (the fix-round pin
      // caught a stale ring answering self-owns-everything here — the hop never left the node and
      // the non-held read fell through to a silent local undefined, §9's banned answer)
      const ring = node.writes.ring
      if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
      const owner = ring.ownerOf(k)
      if (owner && owner !== node.uuid)
        return memberCaller!.call(SYSTEM + 'read', k, { timeout: 8000, to: owner })
      //! THIS node is the owner but does not hold k — the handover windows (finding 15 and its
      // pre-latch sibling the fix-round pin caught): ACQUIRING (base mid-latch), ENTRY-ABSENT
      // (assigned but not yet offered — the liveness rounds close it within a tick or two), and
      // the data-at-an-unshed-ORPHAN window (an epoch-0 writer whose broadcast reached nobody
      // still CLAIMS until its shed proves coverage). One mechanism answers all three honestly:
      // THE GATHER — parked claims include every unshed orphan's, absence is attested by the full
      // holder set, and an unreachable member is a typed error, never a silent partial. A truly
      // absent key answers fast (one fan-out round-trip); a local-shard undefined never leaks.
      const union = await gatherOf().refresh(rt, { throwOnPartial: true }) as Record<string, unknown>
      return union[k]
    }
    return bind.data.get(k)
  }
  const remoteKey = (k: string): unknown => new Proxy(Object.freeze({}), {
    get(_, prop) {
      if (prop === 'then') {
        //! the one-shot fetch rides keyedRead — the SYSTEM plane + the acquiring-owner guard
        // (M6-review findings 5/15), never the public 'read' dispatch
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => keyedRead(k).then(F, R)
      }
      if (prop === Symbol.toStringTag) return 'FeroRemoteKey'
      if (typeof prop === 'symbol') return undefined
      return scopedThrow('get', 'shortfall', `'${k}' lives on its holders — await data.${k} (or methods.read('${k}')) for the value`, k)
    },
  })
  const dataSurface = !scoped ? bind.data : new Proxy(bind.data, {
    get(t, prop, r) {
      //! coercing the ROOT on an ARMED node (I-25) is a sync local read of the shard — `snapshot`'s rule:
      // typed, never a silent partial. A held child coerces to its cell through the lens as everywhere.
      if ((prop === Symbol.toPrimitive || prop === 'valueOf') && node.armed)
        return scopedThrow(prop === 'valueOf' ? 'valueOf' : 'toPrimitive', 'holistic', 'a scoped node holds a shard — await data (the gather) or methods.read() for the whole resource')
      if (typeof prop === 'symbol') return Reflect.get(t, prop, r)
      if (prop === 'then') {
        //! `await data` means the RESOURCE — the gather, never the shard (typed reject on shortfall)
        return (F?: (v: unknown) => unknown, R?: (e: unknown) => unknown) => gatherOf().refresh(rt, { throwOnPartial: true }).then(F, R)
      }
      //! the hint is a recipe that RUNS (ISSUES I-26): read() resolves to a PLAIN object, so the rows are
      // Object.values(…) — with the Array method of the same name when there is one (filter, map, some …)
      if (OPERATORS.has(prop))
        return scopedThrow(prop, 'holistic', `materialize first: Object.values(await methods.read())${typeof (Array.prototype as unknown as Record<string, unknown>)[prop] === 'function' ? '.' + prop + '(…)' : ''} — the rows as a plain array (await data is the same gather) — or define a derived resource`)
      if (prop === 'get') return (k: unknown) => (!node.armed || node.scope!.held(String(k)) ? t[String(k)] : remoteKey(String(k)))
      if (!node.armed || node.scope!.held(prop)) return Reflect.get(t, prop, r)
      return remoteKey(prop)
    },
  })

  //! the built-in read: the whole resource or one child — subscribable by return type like any
  // method. Scoped + no key = THE GATHER (v2 Q3: read() IS the download): one-shot on CALL, the
  // live parked-union proxy on SUB (ctx.live — re-gathered on installs + a paced tick).
  const table: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    read: (a, ctx) => {
      if (a != null) {
        //! a keyed read on a scoped node for a NON-HELD partition routes to the owner (one hop) —
        // the same answer at R=2 and R=∞, never a silent local undefined (plan §9). The routed hop
        // travels keyedRead (SYSTEM plane + acquiring guard — M6-review findings 5/15); the held/
        // unscoped case stays a SYNC child read so a keyed SUB still streams a live proxy.
        const k = String(a)
        if (scoped && node.armed && !node.scope!.held(k)) return keyedRead(k)
        return ctx.data.get(k)
      }
      if (!scoped || !node.armed) return ctx.data
      //! the live cadence is FLOORED (M6-review finding 9): heartbeat.ms 0 is the documented
      // heartbeat opt-out, not a request for a ~1ms full-cluster refresh storm
      if (ctx.live) { const g = gatherOf(); g.live(liveCadence(heartbeatMs)); return g.proxy }
      return gatherOf().refresh(rt, { throwOnPartial: true })
    },
    ...(userMethods as Record<string, (arg: unknown, ctx: Context) => unknown>),
  }
  //! the system plane: confirm-over-RPC — a spoke's ladder evidence is one digest wide (M5b residual),
  // so its probes run at the PRIMARY, which holds the full member evidence. `rows` (M6) answers the
  // gather fan-out with this node's stamped claims (held ∪ orphan — an orphan claims until shed).
  // `read` (M6-review finding 5) is the KEYED read the internal machinery dispatches — off the
  // user-claimable namespace, so a user method named 'read' only ever changes the PUBLIC dispatch.
  const system: Record<string, (arg: unknown, ctx: Context) => unknown> = {
    confirm: (a) => {
      const v = a as { o: string; s: number; l: number; t: number; pt?: string }
      return probe({ origin: v.o, seq: v.s, epoch: 0 }, v.l, Math.min(v.t ?? 8000, 60_000), v.pt)
    },
    rows: () => rowsPartial(rt),
    read: (a) => keyedRead(String(a)),
  }
  //! the Host receives the SCOPED facade as ctx.data (M6-review finding 4): a handler's
  // `ctx.data[id]` / `ctx.data.filter(…)` must mean the same as the public surface — typed
  // routing/refusal, never a silent shard read. Unscoped servers: dataSurface IS bind.data,
  // byte-identical to before.
  host = new Host(rt, dataSurface, table, system)
  const caller = isClient ? new Caller(rt) : null

  //! ── the default write methods: the SAME ingest as assignment, plus await surfaces ──
  const write = async (rec: Rec, o: WriteOpts = {}): Promise<WriteResolve> => {
    const want: Guarantee = o.confirm ?? 'committed'
    const ms = o.timeout ?? 10_000
    const key = rec.key.length ? rec.key : [String(rec.at ?? '')]
    //! every refusal is ONE WriteRejectError: the typed fields, and a message that names the resource,
    // the verb, the key, what happened and the rung reached — `tail` is the pointer, when there is one
    const reject = (fields: Omit<WriteReject, 'guarantee'>, what: string, tail = ''): WriteRejectError =>
      new WriteRejectError({ guarantee: want, ...fields }, `fero('${name}') ${VERB_NAMES[rec.type]} ${JSON.stringify(key)}: ${what} — reached ${fields.reached}${tail}`)
    const explain = (reason: string): string => reason === METHODS_ONLY ? `${reason} (the server takes changes only through its methods)` : reason
    //! the one hint a timed-out client needs most (rung 04's finding): nothing is connected to write to
    const nobody = (): string => caller && node.primary === null ? ' (nobody to write to: a bare fero(name) is a client; pass server: true to host)' : ''
    //! an EMPTY key on update/remove is refused HERE, before any stamp (ISSUES I-30): `Change.key` is
    // optional, so `methods.update({ value })` type-checks — and the kernel's projection was the first to
    // object, by throwing inside step(): the process died, and on a cluster died a second time when the
    // record re-applied a second later, outside any try. An insert without a key is fine: `at` is its row.
    if (rec.key.length === 0 && rec.type !== REC.insert)
      throw reject({ reached: 'issued', reason: 'invalid-key' }, 'invalid-key', rec.type === REC.remove
        ? " (a remove needs a key: methods.remove({ key: 'k' }) is delete data.k)"
        : " (a write needs a key: methods.update({ key: 'k', value }) is data.k = v)")
    const r = bind.issue([rec])[0]
    if (typeof r === 'string') throw reject({ reached: 'issued', reason: r }, explain(r))
    //! the timeout timer is CAPTURED and CLEARED on settle (M5-review #3: the bare setTimeout leaked one
    // live timer + reject closure per write for the full `ms` on the hot path). And a POST-ISSUE kernel
    // reject ('superseded'/'dropped'/'destroyed') is normalized to a typed WriteReject (M5-review #9:
    // the bare string escaped the WriteReject contract). Only the coordinate resolution races the timer.
    let timer: ReturnType<typeof setTimeout>
    const coords = await new Promise<Coords>((resolve, rej) => {
      timer = setTimeout(() => rej(reject({ reached: 'issued', reason: 'timeout' }, `timeout after ${ms}ms`, nobody())), ms)
      timer.unref?.()
      ;(r as Promise<Coords>).then(resolve, (e) =>
        rej(typeof e === 'string' ? reject({ reached: 'issued', reason: e }, explain(e)) : e))
    }).finally(() => clearTimeout(timer))
    const resolved: WriteResolve = { guarantee: 'committed', key, origin: coords.origin, seq: coords.seq, epoch: coords.epoch, cid: coords.cid }
    if (want === 'committed') return resolved
    const localCommit = { origin: coords.origin, seq: coords.seq, epoch: coords.epoch }
    const where = `${coords.origin} seq ${coords.seq} epoch ${coords.epoch}`
    const level = want === 'persisted' ? CONFIRM.persisted : CONFIRM.replicated
    //! 'persisted' where no disk can ever prove it: this node has no dir AND no member has ever announced
    // durable evidence (a digest `p` map — Confirm.durablePeer), so the probe could only wait out its
    // deadline. Rejected AT ONCE instead, with the pointer — after the commit, so the write still landed
    // and `localCommit` says where (a reject is not a rollback). Servers only: a server hears every
    // member's digest; a client hears its primary alone and cannot know what the rest of the view holds.
    // A memory-only member beside a durable majority keeps probing — that majority proves it.
    if (want === 'persisted' && !caller && !node.durable && !node.membership.view.members.some(([u]) => u !== node.uuid && node.confirm.durablePeer(u)))
      throw reject({ reached: 'committed', reason: 'not-durable', localCommit }, 'not-durable', ` (${where}; no dir here and no member has announced a disk — pass dir: to persist)`)
    //! a spoke proves its guarantee AT THE PRIMARY (system confirm) — its own evidence is one digest
    // wide. `pt` (M6): the partition rides along so an armed prover ranges the probe over the R-set.
    const pt = partitionOf(rec)
    const ok = caller
      ? await caller.call(SYSTEM + 'confirm', { o: coords.origin, s: coords.seq, l: level, t: ms, pt }, { timeout: ms, retry: true }).then((v) => v === true, () => false)
      : await probe(coords, level, ms, pt)
    if (!ok) throw reject({ reached: 'committed', reason: 'timeout', localCommit }, `timeout after ${ms}ms`, ` (${where})`)
    return { ...resolved, guarantee: want }
  }

  const methods = {
    update: (c: Change, o?: WriteOpts) => write({ type: REC.update, key: keyPath(c.key), value: c.value }, o),
    //! an insert without `at` mints its row key here (the substrate's proxy.insert mints too — the
    // wire needs the key BEFORE routing, so the api is the mint site for method-issued inserts)
    insert: (c: Change, o?: WriteOpts) => write({ type: REC.insert, key: keyPath(c.key), value: c.value, at: String(c.at ?? randomUUID()) }, o),
    remove: (c: Change, o?: WriteOpts) => write({ type: REC.remove, key: keyPath(c.key) }, o),
  } as Methods
  //! user methods + the built-in read. On a SERVER a call routes through host.invokeLocal — the SAME
  // flush-on-return + non-blind-await + proxy-collapse (with a CLONE) as a wire CALL, so local and
  // remote invocation of the same handler are indistinguishable (M5-review #5/#10). Live local
  // projections are `data` + operators directly, no method needed. On a CLIENT the namespace is OPEN
  // (a spoke cannot know the servers' method names): ANY name yields the dual-mode Handle maker
  // (await = one-shot CALL, reactive touch = live subscription); unknown names reject typed FROM the server.
  if (!caller) {
    for (const m of Object.keys(table)) methods[m] = (a?: unknown) => host!.invokeLocal(m, a)
  }
  const methodSurface = caller
    ? new Proxy(methods, {
        get(t, prop) {
          if (typeof prop !== 'string' || prop in t || prop === 'then') return (t as Record<string | symbol, unknown>)[prop]
          return (a?: unknown, o?: { timeout?: number; retry?: boolean }) => handle(caller, prop, a, o)
        },
      })
    : methods

  //! ── cluster: a real ViewProxy over the committed view + peers + me (M5a minimal) ──
  // Folded from the journal cursor after any step that emitted membership-relevant events; one
  // integer compare per event otherwise. M5d makes this end-to-end (writes ring, partitions).
  //! cluster.partitions (M6, DESIGN-M6 C9): bounded local scalars, zeros while unscoped. The scope
  // tallies + shedWaitingOn fold from the kernel scope map once slice 4 wires JK 59-63; until then
  // the row is a truthful projection of "nothing is scoped on this node".
  let acquiredEver = 0
  let shedEver = 0
  const partitionsRow = () => {
    const t = node.scope?.tallies() ?? { held: 0, acquiring: 0, orphaned: 0 }
    return {
      replicas: node.replicas,
      epoch: node.epoch,
      w: node.replicas > 0 ? (Math.min(node.replicas, Math.max(node.membership.view.members.length, 1)) >> 1) + 1 : 0,
      held: t.held, acquiring: t.acquiring, orphaned: t.orphaned,
      acquired: acquiredEver, shed: shedEver,
      shedWaitingOn: node.armed ? node.scope!.shedWaitingOn(node) : [] as string[],
    }
  }
  //! me carries the ROLE, the EFFECTIVE dial targets (static ∪ discovered — on every role, V4-3) and the
  // rendezvous state (v4.1's observability finding, extended: a bare client's "nobody registered yet"
  // ({hosts: [], rendezvous.up: true}) and "no directory on this box" (up: false) read differently;
  // none of it needs the diagnostics seam). `listen` re-folds after start — port 0 resolves there.
  let discovered: string[] = []
  let directory: Directory | null = null
  //! meets — the ONE predicate for "this instance meets a directory": a rendezvous is set AND the
  // instance is dialable (a client) or dialed (a listening server) — a socketless solo meets none and
  // says `false`, never "down" (the panel's observability finding)
  const meets = rendezvous !== false && (isClient || listen !== undefined)
  const meRow = () => ({
    uuid: node.uuid, origin: node.uuid + '~' + node.incarnation, listen: node.listen,
    role: isClient ? 'client' : 'server',
    hosts: [...new Set([...(hosts ?? []), ...discovered])].filter((h) => h !== node.listen),
    rendezvous: meets
      ? { addr: rendezvous as string, hosting: directory?.hosting ?? false, up: directory?.up ?? false, ...(directory?.error !== undefined ? { error: directory.error } : {}) }
      : false as const,
  })
  const cluster: any = proxy({
    epoch: node.epoch,
    writable: node.membership.gate(node).open,
    members: {},
    peers: {},
    writes: {},
    me: meRow(),
    partitions: partitionsRow(),
  })
  const FOLD = new Set<number>([JK.viewInstall, JK.evict, JK.gateOpen, JK.gateClose, JK.identified, JK.linkDown, JK.suspect, JK.start,
    //! M6: the scope lifecycle re-folds cluster.partitions (tallies + lifetime counters + the H7 surface)
    JK.shed, JK.acquire, JK.orphaned, JK.acquireStart, JK.acquireAbort, JK.shedStall])
  let cursor = 0
  let lastPrimary = node.primary
  let lastOutcomes = 0
  let lastScopeN = -1
  let lastMembers = '0:'
  let lastPeers = ''
  let lastPartitions = cluster.snapshot().partitions as ReturnType<typeof partitionsRow>
  const samePartitions = (a: ReturnType<typeof partitionsRow>, b: ReturnType<typeof partitionsRow>): boolean =>
    a.replicas === b.replicas && a.epoch === b.epoch && a.w === b.w && a.held === b.held && a.acquiring === b.acquiring &&
    a.orphaned === b.orphaned && a.acquired === b.acquired && a.shed === b.shed &&
    a.shedWaitingOn.length === b.shedWaitingOn.length && a.shedWaitingOn.every((u, i) => u === b.shedWaitingOn[i])
  const fold = () => {
    //! settle kernel-side outcomes FIRST (two integer compares when nothing moved): a relay's `invalid`
    // WNACK removes our attempt inside a step that applies nothing, so the write's promise
    // would otherwise wait for the next apply — the sweep rides the post-step hook instead
    bind.sweep()
    //! cluster.writes — the bounded confirm ring (plan §9; Q4 decided: pending rows are visible HERE,
    // never marked inside `data`): folded whole when the ring version moved, one compare otherwise
    if (bind.outcomes.n !== lastOutcomes) {
      lastOutcomes = bind.outcomes.n
      const rows: Record<string, unknown> = {}
      for (const [id, o] of bind.outcomes.rows) rows[id] = { ...o }
      cluster.set('writes', rows)
    }
    const j = node.journal
    let refold = false
    if (j.n !== cursor) {
      const events = j.read(cursor)
      cursor = j.n
      //! method-plane housekeeping rides the same fold: dead links reap their served subscriptions
      // (the v2 leak guard), and a primary change fires the caller's failover policies (OQ2)
      for (const e of events) {
        if (e.kind === JK.linkDown) host!.reapLink(e.a as number)
        //! M6: the kernel shed a partition — mirror it out of the proxy (ONE synthesized subtree
        // remove, echo pre-consumed: nothing re-issues) and count the lifetime tallies
        else if (e.kind === JK.shed) { shedEver++; bind.shedPartition(String(e.a)) }
        else if (e.kind === JK.acquire) acquiredEver++
        //! M6: a view install re-gathers the LIVE union against the new ring (the Q3a leg) — but
        // ONLY when the gather was ever consumed (M6-review finding 41): `gather` stays null until
        // read()/`await data` materializes it, so an idle scoped cluster pays nothing on churn
        else if (e.kind === JK.viewInstall && gather) void gather.refresh(rt, { throwOnPartial: false }).catch(() => {})
      }
      if (caller && node.primary !== lastPrimary) {
        lastPrimary = node.primary
        if (node.primary !== null) caller.onPrimaryChange()
      }
      if (events.some((e) => FOLD.has(e.kind))) refold = true
    }
    //! cluster.partitions: ONE O(P) recompute per fold() invocation, AFTER the event loop (M6-review
    // finding 42: the tallies + shedWaitingOn walk used to run once for the scope.n drift check and
    // AGAIN in the FOLD branch — coalesced here so each fold pays the walk at most once, and the row
    // still reflects the final post-step state). The scope.n compare catches tally drift that
    // journals nothing (held-mints at the gate/stamp site) — one int compare on the hot path.
    const scopeMoved = node.scope !== null && node.scope.n !== lastScopeN
    if (!refold && !scopeMoved) return
    //! ONE batch, and only the fields that moved (V4-8): a bare `cluster.tap(() => …)` fires once per
    // fold with the whole picture landed — never per field, and never for a refold that changed nothing
    // (data skips a same-value primitive but not an equal-but-new object, so members, peers and the
    // partitions row are compared by signature here). A render loop needs no coalescing and no dedupe.
    batch(() => {
      if (refold) {
        cluster.set('epoch', node.epoch)
        cluster.set('writable', node.membership.gate(node).open)
        const memberSig = node.epoch + ':' + node.membership.view.members.map(([u]) => u).join(' ')
        if (memberSig !== lastMembers) { lastMembers = memberSig; cluster.set('members', Object.fromEntries(node.membership.view.members)) }
        const peers: Record<string, { uuid: string; incarnation: number; up: boolean }> = {}
        for (const l of node.links.values())
          if (l.uuid && !l.dead) peers[l.uuid] = { uuid: l.uuid, incarnation: l.incarnation, up: true }
        const peerSig = Object.keys(peers).sort().map((u) => u + '~' + peers[u].incarnation).join(' ')
        if (peerSig !== lastPeers) { lastPeers = peerSig; cluster.set('peers', peers) }
      }
      if (node.scope) lastScopeN = node.scope.n
      const row = partitionsRow()
      if (!samePartitions(row, lastPartitions)) { lastPartitions = row; cluster.set('partitions', row) }
    })
  }
  rt.hook(fold)

  //! any failure past Runtime construction must tear down what was built — the review caught the
  // leak: a rejected fero() left the bind, the host, and the open WAL fd alive (a listen collision
  // is an ordinary start rejection, not an operator typo)
  const abort = async (err: unknown): Promise<never> => {
    bind.destroy()
    host!.destroy()
    caller?.destroy()
    memberCaller?.destroy()
    gather?.destroy()
    for (const [, settle] of probes) settle(false)
    probes.clear()
    await directory?.destroy().catch(() => {})
    await rt.destroy().catch(() => {})
    throw err
  }
  //! the data seed (v4.1): applied ONLY when the local fold is empty at boot — a durable restore or
  // any replayed state skips it (re-seeding every life would clobber newer values: the restored
  // Lamport ceiling stamps above old writes). The declared seed is CONFIG, so a row the validation
  // seam refuses is a config error and throws at fero() time — pre-validated as a whole batch first,
  // so a rejected seed never half-applies (with dir, a partial seed would persist and no later life
  // could ever complete it: versions.size > 0 skips the retry forever). On first contact with an
  // existing cluster, LWW resolves collisions (higher-epoch cluster stamps win; fresh keys ride in).
  if (config.data !== undefined && rt.node.versions.size === 0) {
    const recs: Rec[] = Object.entries(config.data as Record<string, unknown>).map(([k, v]) => ({ type: REC.update, key: [k], value: v }))
    const validate = seams.validation as ((rec: Rec) => true | string) | undefined
    if (validate)
      for (const r of recs) {
        const v = validate(r)
        if (v !== true) await abort(new Error(`fero('${name}'): data seed row '${r.key[0]}' rejected by seams.validation — ${v}`))
      }
    for (const r of bind.issue(recs))
      if (typeof r === 'string') await abort(new Error(`fero('${name}'): data seed refused by the kernel — ${r}`))
  }
  try {
    await rt.start()
  } catch (err) {
    await abort(err) // an explicit listen that would not bind (EADDRINUSE …) — the default is port 0, which cannot collide
  }
  fold()
  //! the directory (V4-3): wired AFTER start, so a port-0 server registers its REAL address. Servers
  // register and attempt to host; every dialable instance looks its name up live; the folded address
  // set posts as `discover` (the kernel dials/parks) and re-folds cluster.me.hosts.
  if (meets) {
    directory = new Directory({
      compose: (n, o) => compose(n, o, true),
      addr: rendezvous as string, name, uuid: node.uuid,
      listen: () => (isClient ? undefined : node.listen),
      serve: !isClient,
      heartbeatMs: rtOpts.heartbeatMs as number, redialMs: rtOpts.redialMs,
      onHosts: (hs) => { discovered = hs; node.step({ kind: 'discover', hosts: hs }); cluster.set('me', meRow()) },
      onState: () => cluster.set('me', meRow()),
    })
    try { await directory.start() } catch (err) { await abort(err) }
  }
  cluster.set('me', meRow())

  //! teardown — everything destroy() does AFTER the graceful leave (V4-6): the local surfaces, the
  // in-flight confirm probes (settled false = could not prove in time — never hang a caller), the
  // directory client (its link drops ⇒ the host forgets this instance's entries), then the hosted
  // directory if this instance holds it (⇒ the other servers race for the port), then the runtime.
  // The diagnostics crash() door runs THIS alone: a process death, as the cluster would see it.
  const teardown = async () => {
    bind.destroy()
    host!.destroy()
    caller?.destroy()
    memberCaller?.destroy()
    gather?.destroy()
    for (const [, settle] of probes) settle(false)
    probes.clear()
    await directory?.destroy()
    await rt.destroy()
  }
  const inst: Fero = {
    name,
    data: dataSurface,
    methods: methodSurface,
    cluster,
    //! snapshot (v4.1): the sanctioned SYNCHRONOUS whole-resource read — data's [value] materialize,
    // surfaced first-class so render loops need no internals import. A fresh top container per
    // access; rows shared by reference (stringify-and-discard is the intended use — methods.read()
    // remains the cloning path). On an ARMED scoped node a sync local read could only be the shard —
    // §9's banned silent partial — so it throws the typed ScopedError instead.
    get snapshot() {
      if (scoped && node.armed) scopedThrow('snapshot', 'holistic', 'a scoped node holds a shard — await data (the gather) or methods.read() for the whole resource')
      return snapshotOf(bind.data)
    },
    destroy() {
      //! the graceful leave FIRST (V4-6): while the resource is still whole, get the view changed without
      // this node by ballot — a clean stop is not a crash, and a two-member cluster survives it. Bounded
      // in the shell (Runtime.leave); then the ordinary teardown, unchanged. Idempotent (V4-8): the
      // signal handler and the owner's own destroy() may race — the second call joins the first.
      // Untracked when the stop SETTLES, not when it starts (V4-9): the listener stays for the whole
      // leave, so a second signal joins it — a terminal's Ctrl-C reaches a spawned child twice, once
      // from the tty and once from its parent's stop(), and untracking first left Node's default in
      // place to kill the child by signal mid-ballot (a crash, the thing V4-6 and V4-8 exist to avoid).
      if (stopping === null) stopping = rt.leave().then(teardown).finally(() => untrack(inst))
      return stopping
    },
  }
  let stopping: Promise<void> | null = null
  //! [diagnostics] (M7, DESIGN-M7 §3): the Symbol-keyed internals seam — attached WITHOUT widening the
  // typed Fero surface (diag() in api/diagnostics.ts is the one sanctioned door). Every member is a
  // pull or a bounded effect; nothing here runs unless called, so the instance's hot paths are untouched.
  const diagHandle: Diagnostics = {
    capture: () => captureNode(node),
    journal: (from = 0) => ({ n: node.journal.n, dropped: node.journal.dropped, events: node.journal.read(from) }),
    served: () => host!.served,
    confirms: () => ({ api: probes.size, kernel: node.confirm.inflight }),
    logSize: () => { let n = 0; for (const [, entries] of node.logs) n += entries.length; return n },
    compact: () => {
      //! honest refusals (DESIGN-M7 §3, the panel's shared-defect fix): 0 on an ARMED node — compaction
      // is PINNED under scoping (the member-ranged frontier says nothing about a holder's possession;
      // forcing it here would be a diagnostics member that can cause real data loss) — and 0 after
      // destroy. Otherwise the REAL pass, size-gate-free (v2's drive-it-deterministically purpose).
      if (node.armed || node.destroyed) return 0
      let d = 0
      for (const o of [...node.logs.keys()]) d += compact(node, o, frontier(node, o))
      d += gcTombstones(node)
      fold() // compaction ran OUTSIDE node.step — the composer's hook wraps step only, so fold by hand
      return d
    },
    drop: (uuid: string) => rt.drop(uuid),
    crash: () => { untrack(inst); return teardown() },
    rendezvous: () => (directory ? { client: directory.client, host: directory.host } : null),
    //! config (V4-10): every resolved leaf with the layer it came from — the coerced value the composer
    // read, or the effective default ('the default') where one exists; a function shows as '[function]',
    // the hosted methods and the data seed as their names (rows are data, not config)
    config: () => {
      const out: Record<string, { value: unknown; from: string }> = {}
      const effective: Record<string, unknown> = { 'heartbeat.ms': rtOpts.heartbeatMs, 'redial.ms': redialMs ?? 100, 'journal.cap': journalCap ?? 4096, listen: listen ?? config.listen, rendezvous }
      for (const k of CONFIG_LEAVES) {
        const v = k.split('.').reduce<unknown>((o, p) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), config)
        const shown = v !== undefined ? v : effective[k]
        if (shown === undefined) continue
        out[k] = {
          value: typeof shown === 'function' ? '[function]' : k === 'methods' || k === 'data' ? Object.keys(shown as object) : shown,
          from: v !== undefined ? from(k) : k === 'rendezvous' && envDefault !== false ? 'FERO_RENDEZVOUS' : 'the default',
        }
      }
      return out
    },
  }
  ;(inst as Fero & { [diagnostics]?: Diagnostics })[diagnostics] = diagHandle
  if (!isSystem && config.signals !== false) track(inst)   //! the clean stop on Ctrl-C (V4-8); the directory is owned and torn down by its host
  return inst
}

export type { Fero, FeroOpts, Guarantee, WriteResolve, WriteReject, Change, WriteOpts, Methods, Partitions, ScopedError, Spawned, SpawnOpts } from './types.ts'
