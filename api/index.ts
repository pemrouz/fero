//! ── api/index — the composer: fero(name, opts) → { name, data, methods, cluster, snapshot, destroy } ──
// The whole public surface (plan §9, the v2 shape kept): zero events, zero hooks —
// everything reactive is a ViewProxy you connect or tap. Config recognition is by
// DECLARED KEY: every option must be a known FeroConfig key, typos throw at fero()
// time, and hosted methods live under `methods:` — whose presence is THE DOOR (V4-5:
// clients change a protected resource only through its methods). The one other
// function-valued key is `validation:` (once `seams.validation`, still accepted for
// one release — api/config.ts folds it).
//
// M5a scope: the server/solo composer over the shell Runtime — data binding both
// directions with the write-route join (api/data.ts; V4-7: a write shows when it commits), the default write methods with
// {confirm, timeout} against the M4c guarantee ladder, restore-before-network when
// `dir` holds a previous life, and a minimal reactive cluster surface. The client
// role (M5b) and user-method dispatch (M5c) land next.

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { Runtime, restoreOpts, type RuntimeOpts } from '../shell/runtime.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { REC, partitionOf, type Rec } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { TUNE } from '../kernel/tune.ts'
import { Bind, METHODS_ONLY, UNENCODABLE, INVALID_KEY, CARRIES, atCap, unsendable, unsentWhy, reasonOf, type Coords } from './data.ts'
import { fnv } from '../kernel/ring.ts'
import { Caller, Host, SYSTEM, handle, reapStopped, takesKey, type Context } from './methods.ts'
import { Gather, rowsPartial, liveCadence, type Rows } from './fold.ts'
import { proxy, contract, commit, errText, snapshot as snapshotOf, unfoldable, SPARSE_HOLE, holeMessage, DATA_ROOT, FERO_ROOT, type Fault } from './substrate.ts'
import { diagnostics, type Diagnostics } from './diagnostics.ts'
import { Directory, DIRECTORY, RENDEZVOUS, WATCH_TICKS, boxDirectory, hostOf, isAddr, isBox, leavesBox, localish, loopbackHost, rendezvousDefault, sameDirectory, sameSocket } from './directory.ts'
import { resolveConfig, src, secretHint, clientKeyHint, CONFIG_LEAVES, SECRET_MIN } from './config.ts'
import type { Door } from '../kernel/door.ts'
import type { JEvent } from '../kernel/journal.ts'
import type { Node } from '../kernel/node.ts'
import { compact, frontier, gcTombstones } from '../kernel/log.ts'
import { captureNode } from '../tools/debug/capture.ts'
import { track, untrack } from './signals.ts'
import { spawn } from './spawn.ts'
import type { Change, Fero, FeroOpts, Guarantee, Methods, WriteOpts, WriteReject, WriteResolve } from './types.ts'

//! the declared config schema: PICKED keys, everything else is a loud error (plan §9)
const CONFIG_KEYS = new Set(['uuid', 'server', 'listen', 'hosts', 'dir', 'heartbeat', 'redial', 'leave', 'journal', 'replicas', 'data', 'methods', 'validation', 'seams', 'rendezvous', 'diag', 'secret', 'signals'])
const SEAM_KEYS = new Set(['validation'])

//! METHODS_ONLY — the terminal reason a protected server gives a client's plain write (V4-5): it rides
// V4-4's `invalid` WNACK as `m`, surfaces as WriteReject.reason and cluster.writes.reason, and is what a
// plain client assignment is refused with (nothing ever showed — V4-7). A degenerate admission predicate
// folded into the ONE kernel hook. Defined in api/data.ts since DESIGN-DOOR §4 (a client speaks it
// locally when its feeder's HELLO carried the hint); re-exported here unchanged.
export { METHODS_ONLY }
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

//! ── the refusal lines (DESIGN-DOOR §3, §14 Q4): one stderr line per peer address and reason, per process ──
// Fed from the journal rows the composer's cursor reads after every step (the same read `cluster` folds
// from): every `doorReject` reason and `contractReject`; `nameReject` stays silent as today. The rows
// carry no secret, nonce or proof. What a line PRINTS and what it is DEDUPED on are kept apart on purpose
// (the review of 2026-10-09): a peer that can connect chooses its claimed listen, uuid and contract text,
// so those fields are shown only through `shown` — control characters dropped (a newline would forge a
// line, an escape would drive the terminal), cut at SHOWN_MAX — and never key the dedupe. The key is built
// from facts this node owns: the resource, the kind, the reason and the dial target (`to`, still in the
// link table: linkDown lands a step later). A DIALED peer's address is ours (hosts, the directory, the
// view), so each dialed target gets its lines; an ACCEPTED peer has no address we trust, so inbound
// refusals print once per reason per process, however many sockets connect or what they claim. The set
// is capped: past SAID_MAX entries it is cleared and may repeat a line, never grow without bound.
const SHOWN_MAX = 64
const SAID_MAX = 1024
//! clean — the one filter for printed text: no control character (a newline would forge a line, an escape
// would drive the terminal), cut at max from the right, or from the left (a place: the file and line survive)
const clean = (s: string, max: number, left = false): string => {
  const cut = s.length > max * 4 ? (left ? s.slice(s.length - max * 4) : s.slice(0, max * 4)) : s
  const t = cut.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return t.length <= max ? t : left ? '…' + t.slice(t.length - max) : t.slice(0, max) + '…'
}
const shown = (s: string): string => clean(s, SHOWN_MAX)
const said = new Set<string>()
const refusalLine = (name: string, to: string | undefined, e: JEvent, node: Node, clientOnly: boolean): string | null => {
  const c = e.c === undefined ? '' : String(e.c)
  const who = to ?? (c !== '' ? `a peer that connected as ${shown(c)}` : 'a peer that connected')
  const f = `fero('${name}'): refused`
  if (e.kind === JK.contractReject) {
    //! b = the first key that differs (or missing:<key>), c = THEIR value; ours is read off this node's contract
    const key = String(e.b).replace(/^missing:/, '')
    const mine = new Map((node.contract ?? '').split(';').map((t): [string, string] => { const i = t.indexOf('='); return i < 0 ? ['version', t] : [t.slice(0, i), t.slice(i + 1)] }))
    return `${f} ${to ?? 'a peer that connected'} — the cluster contract differs: ${shown(key)} is ${mine.get(key) ?? 'not set'} here, ${c === '' ? 'not set' : shown(c)} there (every member must agree on heartbeat.ms, replicas, methods, validation and ring)`
  }
  //! a CLIENT-ONLY process (DESIGN-DOOR §15: it holds the client key, not the secret) reads the same rows; three of its
  // lines say what it holds, so the operator reaches for the right variable. A member's lines do not change.
  switch (e.b) {
    case 'no-secret': return clientOnly
      ? `${f} ${who} — it has no secret and this process holds the client key; every member must set FERO_SECRET`
      : `${f} ${who} — it has no secret and this node has one; every member must share FERO_SECRET, a client holds it or FERO_SECRET_CLIENT`
    case 'peer-secret': return `${f} by ${who} — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)`
    case 'bad-proof': return clientOnly
      ? `${f} ${who} — its secret does not match this process's client key (FERO_SECRET_CLIENT)`
      : `${f} ${who} — its secret differs from this node's`
    //! `refused` is the peer's NOTICE (DOOR {e: 'denied'}, or a word this version does not know): it read this node's proof
    // and turned it away. A bare close mid-handshake writes no row and prints nothing — it is a link loss (the third review)
    case 'refused': return clientOnly
      ? `${f} ${who} — it refused this process's client key (is FERO_SECRET_CLIENT fero.clientKey of that cluster's secret?)`
      : `${f} ${who} — it refused this node's proof (the secrets probably differ)`
    case 'address': return `${f} ${to ?? 'a dialed peer'} — it answered as ${shown(c)}, not the address the directory or the view gave (a stale or forged entry)`
    case 'timeout': return `${f} ${who} — no proof came within the handshake deadline`
    //! uuid-taken has two sides, told apart by the ROW, not the link table (the third review's minor): the refused
    // client's row (it read the {e: 'uuid-taken'} notice) carries c = its dial target, and the uuid at fault is its
    // own; the refusing node's row carries c = the uuid the client claimed — on an accepted link, or on a DIALED
    // one when a host it dialed answered as a client (or a client it had admitted was evicted by the real member)
    case 'uuid-taken': return to !== undefined && c === to
      ? `${f} by ${to} — the uuid this process runs as, ${node.uuid}, belongs to a member there (a shared FERO_UUID?)`
      : to !== undefined
        ? `${f} ${to} — it answered as a client claiming uuid ${shown(c)}; that uuid belongs to a member (a shared FERO_UUID?)`
        : `${f} a client claiming uuid ${shown(c)} — that uuid belongs to a member (a shared FERO_UUID?)`
    default: return null
  }
}
//! the dial target of the row's link: off the link table, or — for the two reasons whose c IS link.to, a fact this
// node owns — off the row itself, should the link have left the table by fold time (the second review's minor:
// a row read after its linkDown printed as an inbound peer and deduped across every dial target)
const dialTarget = (node: Node, e: JEvent): string | undefined => {
  const to = node.links.get(e.a as number)?.to
  if (to !== undefined) return to
  return e.kind === JK.doorReject && (e.b === 'refused' || e.b === 'timeout') && typeof e.c === 'string' && e.c !== '' ? e.c : undefined
}
const sayRefusal = (name: string, node: Node, e: JEvent, clientOnly: boolean): void => {
  const to = dialTarget(node, e)
  //! the key: owned facts only — a dialed target keys per reason and address; an accepted peer keys on the
  // reason alone. A contract mismatch keys on the KIND either way: the key name is the peer's choice too
  // (a squatter that adds a fresh key per redial would otherwise earn a fresh line per heartbeat — the
  // second review's minor). Never the row's `c`: a claim.
  const key = to !== undefined
    ? `${name}\0${e.kind}\0${e.kind === JK.contractReject ? '' : String(e.b)}\0${to}`
    : `${name}\0${e.kind}\0${e.kind === JK.contractReject ? '' : String(e.b)}`
  if (said.has(key)) return
  const line = refusalLine(name, to, e, node, clientOnly)
  if (line === null) return
  if (said.size >= SAID_MAX) said.clear()
  said.add(key)
  process.stderr.write(line + '\n')
}

//! sayFault — the user's own code threw because fero changed a source it watches (substrate.ts Fault): a view's
// function, a tap or another subscriber, run by data as the commit closed, AFTER the change landed. The change
// stands, data has left the row out of a filter or map that threw on it (and stopped any other view that
// threw), and fero carries on; this says so on stderr, once per bug. `what` is for the composer's and the
// host's own refusals (a validation rule that threw, a result the wire cannot carry), which say what was
// refused instead. It is total: the thrown value can be anything (a null-prototype object, a Proxy, getters
// that throw), and a printer that throws would crash the very step it protects.
//! A bug is the resource, what threw (data's operator name, `tap`, `given`), the thrown value's constructor
// and the user's own place in the stack (`where`) — never the row or the message, which a peer can choose: a
// filter that throws on ten thousand rows is one line, and a burst of bad rows cannot buy a line each. data's
// own errors are known by their shape (a `cause`, and data's wording), not a prefix a message could carry.
// Reading a stack makes V8 format it (tens of µs), so a pre-key without the place is counted first and,
// past FORMAT_MAX repeats, a stack is read at most once a second: a second bug that differs only in its place
// shows within a second of a flood of the first, or is missed if it throws only inside one. The kind of value
// is in the key, so one bug that throws rows of different kinds prints a line per kind (a handful). The sets are their own and capped, so a burst of these never lets the refusal lines repeat.
// Known blur: data runs one runtime per process, so a view of another resource whose commit drained inside
// this one's prints under this one's name.
const FAULT_MAX = 160
const FAULTS_MAX = 1024
const FORMAT_MAX = 64
const faults = new Set<string>()
const formats = new Map<string, { n: number; at: number }>()
const DATA_VIEW = /^data: (\S+) (?:threw on (?:row |\d+ rows )|view threw during a commit and is stopped)/
//! OPS — data's operator names (its exported contract): the only first words a view error of data's carries
// (`filter(rescope)` is filter's re-scoped node); anything else is a user's own error dressed in data's words
const OPS: ReadonlySet<string> = new Set(Object.keys(contract().operators))
const DATA_LOOP = /^data: re-entrant write cascade exceeded (\d+) commits/
//! read — one guarded property read: a getter or a Proxy trap may throw
const read = (x: unknown, k: string): unknown => {
  try { return x !== null && (typeof x === 'object' || typeof x === 'function') ? (x as Record<string, unknown>)[k] : undefined } catch { return undefined }
}
const kindOf = (x: unknown): string => {
  try { const c = x !== null && (typeof x === 'object' || typeof x === 'function') ? Object.getPrototypeOf(x)?.constructor?.name : undefined; return typeof c === 'string' ? clean(c, 40) : typeof x } catch { return typeof x }
}
//! dataView — data's own error for a view (its SCHEDULE clause 4): it always carries the user's throw as
// `cause`, and says which operator; anything else in data's AggregateError is what a tap or subscriber threw
const dataView = (x: unknown): string | null => {
  try {
    if (!(x instanceof Error) || !Object.hasOwn(x, 'cause')) return null
    const m = x.message
    const v = typeof m === 'string' ? DATA_VIEW.exec(m) : null
    return v !== null && OPS.has(v[1].replace(/\(.*\)$/, '')) ? m.slice('data: '.length) : null
  } catch { return null }
}
//! stopsAView — did this fault stop a view (not just leave a row out)? Only then can a live sub be frozen
//! data's cut of a write loop drops the errors it had collected, a view it stopped included — so it counts too
const stopsAView = (e: unknown): boolean => {
  try {
    if (e instanceof Error && !(e instanceof AggregateError) && typeof e.message === 'string' && DATA_LOOP.test(e.message)) return true
    return e instanceof AggregateError && Array.isArray(e.errors) && e.errors.some((x) => dataView(x)?.includes(' view threw during a commit and is stopped') === true)
  } catch { return false }
}
//! where — the user's own place in a thrown value's stack, `file:line:col`: the frames after the message (the
// stack starts with "Name: message", which can carry a row's text), at most 32 of them, skipping frames with
// no file (`<anonymous>`, `node:` internals, natives), data's install and fero's own runtime files, so a
// JSON.parse inside a predicate names the predicate. Cut from the left, so the file and line survive.
const FERO_OWN = /^(?:api|kernel|shell|utils)\/[^/.]+\.ts:/
const where = (x: unknown): string => {
  let real = false
  try { real = x instanceof Error } catch {}
  if (!real) return '' // a stack is read only off a real Error: plain data a peer wrote can carry a `stack` field
  const stack = read(x, 'stack')
  if (typeof stack !== 'string') return ''
  const head = errText(x)
  let i = stack.startsWith(head) ? head.length : 0
  for (let n = 0; n < 32 && i < stack.length; n++) {
    const j = stack.indexOf('\n', i + 1)
    const line = stack.slice(stack[i] === '\n' ? i + 1 : i, j < 0 ? stack.length : j)
    i = j < 0 ? stack.length : j
    const m = /^\s+at (?:.*? \()?(.+?)\)?$/.exec(line)
    if (m === null) continue
    const place = m[1]
    if (!/:\d+:\d+$/.test(place) || place.startsWith('node:') || place.startsWith(DATA_ROOT)) continue
    if (place.startsWith(FERO_ROOT) && FERO_OWN.test(place.slice(FERO_ROOT.length))) continue
    return clean(place, FAULT_MAX, true)
  }
  return ''
}
const sayFault = (name: string, e: unknown, what?: string): void => {
  try {
    //! data's cut of a write loop is thrown alone, never inside its AggregateError
    const loop = what === undefined && e instanceof Error && !(e instanceof AggregateError) && typeof e.message === 'string' ? DATA_LOOP.exec(e.message) : null
    if (loop !== null) {
      if (note(`${name}\0loop`)) process.stderr.write(`fero('${name}'): data cut a write loop after ${loop[1]} commits (a tap or subscriber that writes on every change?) — the last writes it dropped may not show on this node until those rows change again, and what else threw inside the loop was dropped with them; fero carried on\n`)
      return
    }
    const all = what === undefined && e instanceof AggregateError && Array.isArray(e.errors) ? e.errors : [e]
    for (const x of all) sayOne(name, x, what)
  } catch {
    try { process.stderr.write(`fero('${name}'): user code threw while fero applied a change, and its error could not be printed — fero carried on\n`) } catch {}
  }
}
const sayOne = (name: string, x: unknown, given?: string): void => {
  const view = given === undefined ? dataView(x) : null
  const thrown = view !== null ? read(x, 'cause') : x
  //! a given line's text is fero's own words (never a peer's), so it is part of the key: two refusals are two lines
  const op = given !== undefined ? `given\0${given}` : view !== null ? view.split(' ')[0] : 'tap'
  const pre = `${name}\0${op}\0${kindOf(thrown)}`
  const now = performance.now()
  const f = formats.get(pre)
  if (f === undefined) {
    if (formats.size >= FAULTS_MAX) formats.clear()
    formats.set(pre, { n: 1, at: now })
  } else {
    f.n++
    if (f.n > FORMAT_MAX && now - f.at < 1000) return
    f.at = now
  }
  const at = where(thrown)
  if (!note(`${pre}\0${at}`)) return
  const head = given ?? view ?? 'a tap or subscriber threw'
  const why = ` (${clean(errText(thrown), FAULT_MAX)}${at !== '' ? `, at ${at}` : ''})`
  const tail = given !== undefined ? 'fero carried on' : 'the change stands; fero carried on'
  process.stderr.write(`fero('${name}'): ${clean(head, FAULT_MAX)}${why} — ${tail}\n`)
}
//! note — true the first time a key is seen (a new line to print); capped like the refusal lines' set
const note = (key: string): boolean => {
  if (faults.has(key)) return false
  if (faults.size >= FAULTS_MAX) faults.clear()
  faults.add(key)
  return true
}

//! discovery (V4-3, docs/DESIGN-DIRECTORY.md): no name hashing — a server binds a FREE loopback port and
// registers {name, uuid, listen} with the per-box directory (api/directory.ts, the `#directory`
// system resource at the rendezvous address); everyone looks the name up LIVE and the addresses feed
// the kernel's dial set through the `discover` event. Zero addresses configured, zero collisions.
export { RENDEZVOUS, DIRECTORY } from './directory.ts'

//! keyPath — normalize the Change.key sugar: 'user42' and ['user42','active'] are both paths.
const keyPath = (k: string | string[] | undefined): string[] =>
  k === undefined ? [] : Array.isArray(k) ? k.map(String) : [String(k)]

//! hmac — HMAC-SHA256 as base64url (43 characters, kernel/door.ts PROOF_LEN) over `key`, from node:crypto
const hmac = (key: string) => (msg: string): string => createHmac('sha256', key).update(msg).digest('base64url')
//! CLIENT_KEY_LABEL — what the client key is the HMAC of (§15); versioned like the proof's label
const CLIENT_KEY_LABEL = 'fero/client/1'
//! clientKeyOf — the derived client key: HMAC-SHA256(secret, 'fero/client/1') as base64url. The secret is trimmed
// as every layer trims it, so the key a member derives and the key this prints are one string. A short secret is
// refused in the config's words. The same string from a shell (the secret shows in `ps` while openssl runs):
//   printf 'fero/client/1' | openssl dgst -sha256 -hmac "$FERO_SECRET" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='
export const clientKeyOf = (secret: string): string => {
  const s = typeof secret === 'string' ? secret.trim() : secret
  if (typeof s !== 'string' || s.length < SECRET_MIN) throw new Error(`fero.clientKey(secret): the secret must be text of at least ${SECRET_MIN} characters — openssl rand -base64 24 prints a good one`)
  return hmac(s)(CLIENT_KEY_LABEL)
}
export { clientKeyOf as clientKey }

export const fero = (name: string, opts: FeroOpts = {}): Promise<Fero> => compose(name, opts, false)
//! systemCompose — the ONE compose seam every instance hands its Directory: one function for the process, so
// the directory clients it makes are shared by every instance here (api/directory.ts, one client per process)
const systemCompose = (n: string, o: FeroOpts): Promise<Fero> => compose(n, o, true)
//! fero.spawn(file, args?, opts?) (V4-9): `node <file> …` as a separate process — the reader's other terminal, from code (api/spawn.ts)
fero.spawn = spawn
//! fero.clientKey(secret) (DESIGN-DOOR §15): the derived client key, printed once by an operator and handed to
// processes that may only follow (`secret: { client }`, FERO_SECRET_CLIENT)
fero.clientKey = clientKeyOf


//! compose — the composer proper. `system` admits a `#`-prefixed name (the directory) and skips the
// directory for the instance itself (a directory never meets a directory); the public fero() always
// passes false — the # prefix can never be taken by accident.
const compose = async (name: string, opts: FeroOpts, isSystem: boolean): Promise<Fero> => {
  if (typeof name !== 'string' || name === '') throw new Error(`fero(${JSON.stringify(name)}): name must be a non-empty string`)
  if (!isSystem && name.startsWith('#')) throw new Error(`fero('${name}'): names starting with # are reserved for system resources (${DIRECTORY})`)
  //! every option is a DECLARED key (V4-5): a function-valued option is the pre-V4-5 method spelling —
  // refused with the pointer (moving it under `methods:` also declares the door, on purpose)
  for (const [k, v] of Object.entries(opts as Record<string, unknown>))
    if (typeof v === 'function' && k !== 'methods' && k !== 'validation') // `methods: fn` gets the plain-object message below, not a pointer to methods: { methods }
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
  const plainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const m = config.methods
  if (m !== undefined && !plainObject(m))
    throw new Error(`fero('${name}'): methods must be a plain object of handlers — methods: { sell(arg, ctx) { … } } (own functions, not a class instance) — its presence makes the resource protected (clients change data only through them)`)
  const userMethods = (config.methods ?? {}) as Record<string, (...args: unknown[]) => unknown>
  for (const [k, v] of Object.entries(userMethods)) {
    if (typeof v !== 'function') throw new Error(`fero('${name}'): methods.${k} must be a function (arg, ctx) => …`)
    if (k.startsWith(SYSTEM)) throw new Error(`fero('${name}'): method names may not start with \\u0000 (reserved for the system plane)`)
    if (k === 'update' || k === 'insert' || k === 'remove') throw new Error(`fero('${name}'): methods.${k} is a built-in writer — guard it with validation: or name the method differently`)
  }
  const methodsOnly = config.methods !== undefined
  const seams = (config.seams ?? {}) as Record<string, unknown>
  for (const k of Object.keys(seams))
    if (!SEAM_KEYS.has(k)) throw new Error(`fero('${name}'): unknown seam '${k}' — M5a ships ${[...SEAM_KEYS].join(', ')}; hash/codec/storage land with their milestones`)
  //! validation: — the schema check on every record that enters (V4-4). api/config.ts folds the old
  // `seams.validation` spelling into it for a public fero(); a system compose passes its opts as given.
  const validate = (config.validation ?? seams.validation) as ((rec: Rec) => true | string) | undefined
  if (validate !== undefined && typeof validate !== 'function')
    throw new Error(`fero('${name}'): validation must be a function (record) => true | 'the reason' — it runs on every write that enters`)
  //! the cluster contract hashes the validator's SOURCE TEXT (DESIGN-DOOR §4): a bound or native function
  // prints `[native code]`, so two different rules would hash alike and drift would hide — refused here.
  if (validate !== undefined && /\[native code\]/.test(Function.prototype.toString.call(validate)))
    throw new Error(`fero('${name}'): validation must be a plain function whose source is visible — a bound or native function prints [native code], so two different rules would look the same to the cluster contract; write the rule as (record) => … instead`)
  //! diag: { allow: { name: token } } — the DIAG channel's allowlist (kernel NodeOpts.diag): absent, the
  // channel is dead and every debugger attach is denied. The string layers were checked in api/config.ts;
  // the call is checked here. The tokens never reach a message or the diagnostics door.
  const diagGroup = config.diag
  if (diagGroup !== undefined && !plainObject(diagGroup)) throw new Error(`fero('${name}'): diag is a group — diag: { allow: { <name>: <token> } }${at('diag.allow')}`)
  const diagAllow = (diagGroup as { allow?: unknown } | undefined)?.allow
  if (diagAllow !== undefined) {
    if (!plainObject(diagAllow)) throw new Error(`fero('${name}'): diag.allow must be an object of name → token${at('diag.allow')}`)
    for (const [who, tok] of Object.entries(diagAllow as Record<string, unknown>))
      if (typeof tok !== 'string' || tok === '') throw new Error(`fero('${name}'): diag.allow.${who} must be a non-empty token string${at('diag.allow')}`)
  }
  //! secret (DESIGN-DOOR §5): the string layers were coerced in api/config.ts (the OFF set → false, a short
  // or non-text value refused there); the call is checked HERE with the same words — text of SECRET_MIN
  // characters, or false (open on purpose). The value never enters a message. A system resource (the
  // #directory) never carries one: loopback is its trust boundary (api/directory.ts).
  //! trimmed like the text layers trim theirs (api/config.ts coerce), so one member's padded call does not
  // refuse its peers as bad-proof; 16 spaces trim to nothing and are refused below like any short value
  //! secret: { client } (DESIGN-DOOR §15) is the derived CLIENT KEY instead: the layers folded it under `secret`
  // (a leaf and a group), and refused both at once. The call's shape is checked here in the config's words.
  const secretRaw: unknown = config.secret
  const ckeyRaw = plainObject(secretRaw) ? (secretRaw as { client?: unknown }).client : undefined
  const clientKey = typeof ckeyRaw === 'string' ? ckeyRaw.trim() : ckeyRaw
  if (clientKey !== undefined && (typeof clientKey !== 'string' || clientKey.length < SECRET_MIN)) throw new Error(clientKeyHint(name, at('secret.client')))
  const secret = (plainObject(secretRaw) ? undefined : typeof secretRaw === 'string' ? secretRaw.trim() : secretRaw) as string | false | undefined
  if (secret !== undefined && secret !== false && (typeof secret !== 'string' || secret.length < SECRET_MIN))
    throw new Error(`${secretHint(name, at('secret'))}; or secret: false to run open on purpose`)
  const clientOnly = typeof clientKey === 'string'

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
  // and die deep in the shell on Node's raw `Port should be >= 0 and < 65536` (rungs 15 and 16). A BARE
  // host (no port) is the other legal spelling: it names another box, whose directory this instance asks
  // (docs/DESIGN-DIRECTORY.md §11) — a flag or a lone port number is neither.
  if (config.hosts !== undefined) {
    const i = (config.hosts as unknown[]).findIndex((h) => !isAddr(h) && !isBox(h))
    if (i !== -1) {
      const h = (config.hosts as unknown[])[i]
      throw new Error(`fero('${name}'): hosts[${i}] ${typeof h === 'string' ? `'${h}'` : String(h)} is not a 'host:port' address (nor a bare host, which asks that box's directory)${at('hosts')}`)
    }
  }
  if (config.dir !== undefined && (typeof config.dir !== 'string' || config.dir === ''))
    throw new Error(`fero('${name}'): dir must be a non-empty path${at('dir')}`)
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
  //! the client key lets a process FOLLOW, never serve (DESIGN-DOOR §15): a server with only secret.client is
  // refused here in plain words — a member must hold the secret, which is what every other member checks
  if (clientOnly && isServer && !isSystem)
    throw new Error(`fero('${name}'): secret.client is the client key${at('secret.client')} — it lets a process follow, never serve; a server needs the secret (secret: '…' or FERO_SECRET)`)
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
  const group = (k: 'heartbeat' | 'redial' | 'leave' | 'journal'): Record<string, unknown> => {
    const g = config[k]
    if (g === undefined) return {}
    if (typeof g !== 'object' || g === null || Array.isArray(g)) throw new Error(`fero('${name}'): ${k} is a group — ${k}: { ${k === 'journal' ? 'cap' : 'ms'}: … }${at(k)}`)
    return g as Record<string, unknown>
  }
  const heartbeatMs = num('heartbeat.ms', group('heartbeat').ms, 0, false, 'a finite number of milliseconds ≥ 0 (0 = heartbeats off)')
  const redialMs = num('redial.ms', group('redial').ms, 0, false, 'a finite number of milliseconds ≥ 0')
  const redialTries = num('redial.tries', group('redial').tries, 0, true, 'an integer ≥ 0')
  //! leave.ms — the knock window (DESIGN-LEAVE §10.7): how long a clean stop keeps asking a connected member to vote
  // it out. The kernel counts heartbeat ticks (the tune row leaveWindow), so the composer divides by the effective
  // cadence and rounds up; the kernel never lets the row cut the four-tick bound short, so 0 (or anything under
  // four heartbeats) is "the bound alone". With heartbeats off there is no clock and the row stays at its default.
  const leaveMs = num('leave.ms', group('leave').ms, 0, false, 'a finite number of milliseconds ≥ 0 (0 = the four-heartbeat bound alone)')
  const leaveWindow = leaveMs !== undefined && (heartbeatMs ?? 500) > 0 ? Math.max(1, Math.ceil(leaveMs / (heartbeatMs ?? 500))) : undefined
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
  //! hosts split in two (§11): an entry WITH a port is a dial target, as ever; a bare host names another
  // box, and this instance asks that box's directory at its own rendezvous port. Asking needs a port to
  // ask at: with the directory off there is none, and 3376 picked in silence could meet a stranger's
  // directory — so the bare spelling is refused there, with both fixes named.
  const allHosts = config.hosts as string[] | undefined
  const hosts = allHosts?.filter((h) => isAddr(h))
  const bare = allHosts?.filter((h) => !isAddr(h)) ?? []
  if (bare.length > 0 && rendezvous === false)
    throw new Error(`fero('${name}'): hosts entry '${bare[0]}' has no port, which means "ask that box's directory" — but the directory is off${config.rendezvous === false ? ` (rendezvous: false${at('rendezvous')})` : ' (from FERO_RENDEZVOUS)'}: give the entry its port, or turn the directory on`)
  //! the other boxes' directories: one per distinct bare host, this box's own directory left out
  const boxes = rendezvous === false ? [] : [...new Set(bare.map((b) => boxDirectory(b, rendezvous)))].filter((d) => !sameDirectory(d, rendezvous))
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
  //! the explicit-listen rule (§11; it grew out of V4-2's loopback guard): a server's listen is the address
  // it is published and gossiped under. Handed to ANOTHER box, a loopback listen dials that box's own
  // loopback (a futile redial forever, or a same-named stranger welded into membership) and a wildcard
  // (0.0.0.0, ::) is no address at all. So whenever the listen would leave this box — its directory
  // answers other boxes, or its hosts name another box, with a port or without — it must be an address
  // another box can dial. The default listen (127.0.0.1:0) is loopback, so it is refused there too.
  if (!isSystem && listen !== undefined && localish(hostOf(listen))) {
    const why = leavesBox(rendezvous, allHosts ?? [])
    if (why !== null)
      throw new Error(`fero('${name}'): to be reachable from another box, listen on a routable address — ${why}, but listen ${listen}${config.listen === undefined ? ' (the default, a free loopback port)' : at('listen')} ${loopbackHost(hostOf(listen)) ? 'only reaches this box' : 'is a wildcard, not an address another box can dial'}`)
  }
  //! the off-loopback rule (DESIGN-DOOR §5, §14 Q1): a server whose listen other machines can reach must have
  // a secret, or say `secret: false` and own the open door. Loopback is `127.*`, `localhost`, `[::1]` —
  // loopbackHost, NOT localish (a wildcard reaches other machines). After the directory-socket check, so
  // `0.0.0.0:3376` keeps its own refusal. A client is never refused for having no secret.
  if (!isSystem && listen !== undefined && secret === undefined && !loopbackHost(hostOf(listen)))
    throw new Error(`fero('${name}'): listen ${listen} is reachable from other machines and no secret is set — set FERO_SECRET (the same value on every member; a client holds it or FERO_SECRET_CLIENT), or pass secret: false (FERO_SECRET=off) to run open on purpose`)
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
  //! the cluster contract (DESIGN-DOOR §4): what every MEMBER must agree on, as one readable string the
  // server's HELLO carries (`c`). The kernel appends `;ring=fmix32`. heartbeat.ms is the EFFECTIVE value
  // (after the 500 default below); replicas 0 = full replication; methods 1 = the door is on; validation =
  // 8 hex of fnv over the rule's source text, or `none` — hashed even under `methods:` (V4-5's supported
  // pair: the server's own Bind runs the rule under the door). User-resource servers only: a client, the
  // #directory and every embedder pass nothing, so their HELLO stays the v4.0 bytes. A readable string,
  // not a hash: the refusal row can then say WHICH key differs and what the other side runs.
  const clusterContract = isServer && !isSystem
    ? `v1;heartbeat.ms=${heartbeatMs ?? 500};replicas=${(config.replicas as number | undefined) ?? 0};methods=${methodsOnly ? 1 : 0};validation=${validate !== undefined ? fnv(Function.prototype.toString.call(validate)).toString(16).padStart(8, '0') : 'none'}`
    : undefined
  //! three doors from one secret (DESIGN-DOOR §15): a member (or a client trusted with the secret) signs member
  // links with the secret and client links with the derived client key; a CLIENT-ONLY process holds the client
  // key under both names — every proof it can make is a client-key proof. Never the #directory.
  const nonce = () => randomBytes(16).toString('base64url')
  const door: Door | undefined = isSystem ? undefined
    : typeof secret === 'string' ? { mac: hmac(secret), clientMac: hmac(clientKeyOf(secret)), nonce }
    : typeof clientKey === 'string' ? { mac: hmac(clientKey), clientMac: hmac(clientKey), nonce }
    : undefined
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
    //! the tune table (kernel/tune.ts): two rows have a config key — redial.tries → redials (the generic chain;
    // the member chain, memberRedials, keeps its own default and never exceeds it: the kernel caps it) and
    // leave.ms → leaveWindow (the knock window, in ticks). Absent keys leave the row at its default.
    ...(redialTries !== undefined || leaveWindow !== undefined
      ? { tune: { ...(redialTries !== undefined ? { redials: redialTries } : {}), ...(leaveWindow !== undefined ? { leaveWindow } : {}) } }
      : {}),
    ...(config.replicas !== undefined ? { replicas: config.replicas as number } : {}),
    //! the contract and the methods-only hint ride HELLO (DESIGN-DOOR §4) — servers only; absent keys keep
    // every other node's HELLO byte-identical with v4.0
    ...(clusterContract !== undefined ? { contract: clusterContract } : {}),
    //! never the #directory: it is composed WITH methods (its register/lookup door), but it is the system
    // plane and its bytes stay v4.0 — no c, no m, no k (DESIGN-DOOR §6, §8)
    ...(methodsOnly && !isSystem ? { methodsOnly: true } : {}),
    //! the #directory HOST watches its client links (wave 5e): a registrant hung with its socket still open
    // (stopped, wedged) is closed after WATCH_TICKS silent heartbeats, and its entries go with its link
    ...(isSystem && name === DIRECTORY && listen !== undefined ? { watchClients: WATCH_TICKS } : {}),
    //! the door (DESIGN-DOOR §3): the secret as two functions, the `validate` idiom — the kernel never holds
    // the string. mac = HMAC-SHA256 as base64url (43 characters, kernel/door.ts PROOF_LEN); nonce = 16
    // random bytes as base64url (22 characters), from node:crypto, never the shell's Math.random. Servers
    // AND clients (a client proves as the dialer); never the #directory. Absent = the v4.0 wire.
    ...(door !== undefined ? { door } : {}),
    //! the relay's admission predicate (V4-4, V4-5): a client's plain write relayed through this server
    // meets the kernel's relay ingress (kernel/write.ts onWrite) with THIS predicate — under `methods:`
    // the door itself (every relayed record refused 'methods-only', before any user code runs);
    // otherwise the binding's admit: the server's validation:, exactly as for its own issues, then
    // the sparse hole (a relayed remove of an array's own element is refused 'sparse-hole' before it is
    // stamped; the client's own projection may not show the array yet). Zero kernel change for the door:
    // it is what the composer puts INTO the one hook. Inert on a client (nobody relays through a spoke).
    // `bind` is created below, before the runtime can step.
    //! a rule that THROWS on a relayed record (it read rec.value.x, and a remove has no value) refuses that
    // record 'validation-threw' and prints the line: it used to end the server, from the socket handler, for
    // an ordinary delete from any client. The server's own write keeps throwing to its own caller, before
    // anything is stamped.
    validate: methodsOnly ? METHODS_ONLY_ADMIT : (rec: Rec) => {
      try { return bind.admit(rec) } catch (e) { sayFault(name, e, `validation threw on a record a client sent — refused it ('validation-threw')`); return 'validation-threw' }
    },
    //! the owner's re-check of a forwarded remove under a row (DESIGN-SCALE §11 Q12): a scoped member that
    // does not hold the row forwards a remove it cannot judge; the owner, which holds it, asks the sparse-hole
    // half of the same rule again. Armed nodes only (the kernel gates it); never the directory's concern.
    admit: (rec: Rec) => bind.hole(rec),
    //! the DIAG allowlist (M7): present = `npm run debug -- --attach` may read this node with one of its tokens
    ...(diagAllow !== undefined ? { diag: { allow: { ...(diagAllow as Record<string, string>) } } } : {}),
    ...(restored.boot !== undefined ? { boot: restored.boot } : {}),
    ...(restored.incarnation !== undefined ? { incarnation: restored.incarnation } : {}),
  }
  const rt = new Runtime(rtOpts)
  //! the binding wires rt.onApply BEFORE restore, so the WAL replay refills the proxy. `tracked` is
  // late-bound to the method host (flush-on-return attribution — api/methods.ts).
  let host: Host | null = null
  //! cluster.writes — the confirm ring as its OWN data source (not a key of the cluster view): a write
  // outcome is not a picture change, so a bare `cluster.tap` never fires for one. Bind names each row
  // that moved; ONE microtask per burst publishes them (a burst of a thousand assignments is one batch),
  // so a solo write reads `committed` one microtask after it applied — never a kernel step later.
  const writes: any = proxy({})
  //! fault — where the user's own views and taps land when they throw because fero changed a source they
  // watch (substrate.ts Fault): the resource's data, a method's live mirror, the scoped union, the cluster
  // view and its writes ring. One stderr line per failure (sayFault); fero's own work carries on.
  const fault: Fault = (e) => { sayFault(name, e); if (stopsAView(e)) reapStopped() }
  const movedWrites = new Set<number>()
  const shownWrites = new Set<number>()
  let writesQueued = false
  const publishWrites = () => {
    writesQueued = false
    //! no destroyed guard: the stop's own rejects ('destroyed') paint here once, so a screen left open
    // reads what the write's promise said, not `pending` for ever. Nothing moves after that: a destroyed
    // Bind issues nothing (the surface is a local value), and `writes` is a local source with no I/O.
    const rows = bind.outcomes.rows
    commit(fault, () => {
      for (const id of movedWrites) {
        const row = rows.get(id)
        if (row !== undefined) { writes.set(String(id), { ...row }); shownWrites.add(id) }
        else if (shownWrites.delete(id)) writes.get(String(id)).remove()
      }
    })
    movedWrites.clear()
  }
  const bind = new Bind(rt, {
    validate,
    onFault: fault,
    tracked: () => host?.tracked(),
    onOutcome: (id) => {
      movedWrites.add(id)
      if (!writesQueued) { writesQueued = true; queueMicrotask(publishWrites) }
    },
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
  const memberCaller = scoped ? new Caller(rt, fault) : null
  //! the gather (M6, DESIGN-M6 C5): whole-resource read() under scoping — memoized, ONE per node,
  // and LAZY (M6-review finding 41): constructed on FIRST consumption (read() / `await data`), so a
  // scoped server whose union nobody ever reads never fans out N² full-claims downloads on view
  // installs — the install-triggered refresh below fires only once `gather` is non-null.
  //! A member whose share is bigger than one frame refuses its `rows` answer typed (V4-51): the live union then ends
  // the live reads it feeds (host.endLive), never a silent partial (plan §9).
  let gather: Gather | null = null
  const gatherOf = (): Gather =>
    (gather ??= new Gather(rt, (uuid, t) => memberCaller!.call(SYSTEM + 'rows', undefined, { timeout: t, to: uuid }) as Promise<Rows>, fault,
      (r) => { if (gather !== null) host?.endLive(gather.proxy, r) }))

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
      return await gatherOf().refresh(rt, { throwOnPartial: true, key: k })
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
    read: takesKey((a, ctx) => {
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
      //! a gather whose last generation could not take a member's share (bigger than one frame, V4-51) fails a new
      // live read at once, typed. One generation is kicked off, so a share that has shrunk is seen by the next try
      // even when no live read keeps the paced re-gather running.
      if (ctx.live) {
        const g = gatherOf()
        if (g.refused !== null) { void g.refresh(rt, { throwOnPartial: false, want: false }).catch(() => {}); throw g.refused }
        g.live(liveCadence(heartbeatMs))
        return g.proxy
      }
      return gatherOf().refresh(rt, { throwOnPartial: true })
    }),
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
    read: takesKey((a) => keyedRead(String(a))),
  }
  //! the Host receives the SCOPED facade as ctx.data (M6-review finding 4): a handler's
  // `ctx.data[id]` / `ctx.data.filter(…)` must mean the same as the public surface — typed
  // routing/refusal, never a silent shard read. Unscoped servers: dataSurface IS bind.data,
  // byte-identical to before.
  host = new Host(rt, dataSurface, table, system, (e, what) => sayFault(name, e, what))
  const caller = isClient ? new Caller(rt, fault) : null

  //! ── the default write methods: the SAME ingest as assignment, plus await surfaces ──
  const write = async (rec: Rec, o: WriteOpts = {}): Promise<WriteResolve> => {
    const want: Guarantee = o.confirm ?? 'committed'
    const ms = o.timeout ?? 10_000
    const key = rec.key.length ? rec.key : [String(rec.at ?? '')]
    //! every refusal is ONE WriteRejectError: the typed fields, and a message that names the resource,
    // the verb, the key, what happened and the rung reached — `tail` is the pointer, when there is one
    const reject = (fields: Omit<WriteReject, 'guarantee'>, what: string, tail = ''): WriteRejectError =>
      new WriteRejectError({ guarantee: want, ...fields }, `fero('${name}') ${VERB_NAMES[rec.type]} ${JSON.stringify(key)}: ${what} — reached ${fields.reached}${tail}`)
    const explain = (reason: string): string => reason === METHODS_ONLY ? `${reason} (the server takes changes only through its methods)`
      : reason === 'validation-threw' ? `${reason} (the server's validation: rule threw on this record; the server's stderr says where)`
      : reason === UNENCODABLE ? `${reason} (${unsentWhy(rec) ?? unsendable(rec, atCap(node.tune.frame).write) ?? 'the value cannot be sent'}; ${CARRIES})`
      : reason === SPARSE_HOLE ? `${reason} (${holeMessage(key)})`
      : reason === INVALID_KEY ? `${reason} (a key data cannot fold)` : reason
    //! the one hint a timed-out client needs most (rung 04's finding): nothing is connected to write to
    const nobody = (): string => caller && node.primary === null ? ' (nobody to write to: a bare fero(name) is a client; pass server: true to host)' : ''
    //! an EMPTY key on update/remove is refused HERE, before any stamp (ISSUES I-30): `Change.key` is
    // optional, so `methods.update({ value })` type-checks — and the kernel's projection was the first to
    // object, by throwing inside step(): the process died, and on a cluster died a second time when the
    // record re-applied a second later, outside any try. An insert without a key is fine: `at` is its row.
    if (rec.key.length === 0 && rec.type !== REC.insert)
      throw reject({ reached: 'issued', reason: INVALID_KEY }, INVALID_KEY, rec.type === REC.remove
        ? " (a remove needs a key: methods.remove({ key: 'k' }) is delete data.k)"
        : " (a write needs a key: methods.update({ key: 'k', value }) is data.k = v)")
    //! an insert adds a ROW (V4-52): data folds it at the resource (key [] and a row in `at`) or at a one-part key,
    // never under a row. `methods.insert({ key: ['row', 'f'] })` was stamped and then refused by data: the call
    // rejected with data's words after the stamp and its write stayed `pending` for ever; a client's threw in the
    // server's socket handler. Refused here, before anything is stamped or relayed, like the empty key above.
    if (unfoldable(rec))
      throw reject({ reached: 'issued', reason: INVALID_KEY }, INVALID_KEY, rec.key.length > 1
        ? ' (an insert adds a row: its key is the row alone, or none; methods.update({ key: [row, field], value }) sets a field)'
        : ' (an insert needs its row: a non-empty at, or none and fero mints one)')
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
  //! me carries the ROLE, the TOLD dial targets (`hosts` config ∪ what the directory published — on
  // every role, V4-3; the kernel dials MORE: every member the view teaches it — `peers` is the linked
  // set) and the rendezvous state (v4.1's observability finding, extended: a bare client's "nobody
  // registered yet" ({hosts: [], rendezvous.up: true}) and "no directory on this box" (up: false) read
  // differently; none of it needs the diagnostics seam). `listen` re-folds after start — port 0 resolves there.
  let discovered: string[] = []
  let directory: Directory | null = null
  let undrained = 0
  //! meets — the ONE predicate for "this instance meets a directory": a rendezvous is set AND the
  // instance is dialable (a client) or dialed (a listening server) — a socketless solo meets none and
  // says `false`, never "down" (the panel's observability finding)
  const meets = rendezvous !== false && (isClient || listen !== undefined)
  const meRow = () => ({
    //! origin is THE lane this life stamps under — the kernel's spelling (kernel/node.ts: the bare uuid in
    // life 1, uuid~N after), so it joins with WriteResolve.origin and cluster.writes[*].origin in every
    // life; `incarnation` is the life counter for screens that want one
    uuid: node.uuid, origin: node.origin, incarnation: node.incarnation, listen: node.listen,
    role: isClient ? 'client' : 'server',
    //! undrained (DESIGN-SCALE stage 1 (b)): on a scoped member's clean stop, the partitions it went with because no
    // reachable new holder proved it holds them inside the drain window (the kernel's `undrained` row); 0 until then
    undrained,
    //! primary: the ONE server this client digests (kernel/node.ts `primary`, a link id there) — its uuid,
    // null while unconnected and always on a server. Re-folded below on every primary change.
    primary: node.primary !== null ? node.links.get(node.primary)?.uuid ?? null : null,
    hosts: [...new Set([...(hosts ?? []), ...discovered])].filter((h) => h !== node.listen),
    rendezvous: meets
      ? {
          addr: rendezvous as string, hosting: directory?.hosting ?? false, up: directory?.up ?? false, ...(directory?.error !== undefined ? { error: directory.error } : {}),
          //! boxes (§11): the other boxes' directories this instance asks — present only when hosts names one
          ...(boxes.length > 0 ? { boxes: directory?.boxes ?? Object.fromEntries(boxes.map((b) => [b, { up: false }])) } : {}),
        }
      : false as const,
  })
  //! writable, by role (I-33): a member reads its own write-gate; a client has no gate — it reads its
  // feeder's, which rides every digest the feeder sends it (`w`, kernel/node.ts feederOpen), so it is
  // one heartbeat behind at worst, and false with no feeder or before the feeder has said
  const writableNow = (): boolean => isClient ? node.primary !== null && node.feederOpen === true : node.membership.gate(node).open
  const cluster: any = proxy({
    epoch: node.epoch,
    writable: writableNow(),
    members: {},
    peers: {},
    me: meRow(),
    partitions: partitionsRow(),
  })
  const FOLD = new Set<number>([JK.viewInstall, JK.evict, JK.gateOpen, JK.gateClose, JK.identified, JK.linkDown, JK.suspect, JK.start,
    //! M6: the scope lifecycle re-folds cluster.partitions (tallies + lifetime counters + the H7 surface)
    JK.shed, JK.acquire, JK.orphaned, JK.acquireStart, JK.acquireAbort, JK.shedStall])
  let cursor = 0
  let lastPrimary = node.primary
  let lastFeederOpen = node.feederOpen
  let lastScopeN = -1
  let lastMembers = '0:'
  let lastPeers = ''
  let lastPartitions = cluster.snapshot().partitions as ReturnType<typeof partitionsRow>
  const samePartitions = (a: ReturnType<typeof partitionsRow>, b: ReturnType<typeof partitionsRow>): boolean =>
    a.replicas === b.replicas && a.epoch === b.epoch && a.w === b.w && a.held === b.held && a.acquiring === b.acquiring &&
    a.orphaned === b.orphaned && a.acquired === b.acquired && a.shed === b.shed &&
    a.shedWaitingOn.length === b.shedWaitingOn.length && a.shedWaitingOn.every((u, i) => u === b.shedWaitingOn[i])
  //! stopping — the ONE stop, whoever starts it (V4-8): the owner's destroy(), the signal handler, or a
  // signal that lands BEFORE fero() resolves. A second caller joins the first. Declared before the fold:
  // the fold reads it (a stopping node paints no more cluster frames).
  let stopping: Promise<boolean> | null = null
  const fold = () => {
    //! settle kernel-side outcomes FIRST (two integer compares when nothing moved): a relay's `invalid`
    // WNACK removes our attempt inside a step that applies nothing, so the write's promise
    // would otherwise wait for the next apply — the sweep rides the post-step hook instead
    bind.sweep()
    const j = node.journal
    let refold = false
    let primaryMoved = false
    if (j.n !== cursor) {
      //! the ring overflowed past our cursor (journal.cap below one step's burst — or one huge catch-up
      // step): the rows this loop rides on may be gone. `dropped` is the oldest row still held, so this
      // is one compare. What they would have done is re-derived from live state below the loop.
      const lost = j.dropped > cursor
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
        //! the drain gave up on this many partitions (DESIGN-SCALE stage 1 (b)): cluster.me says so before the teardown
        else if (e.kind === JK.undrained) { undrained = e.a as number; commit(fault, () => cluster.set('me', meRow())) }
        //! the door refused a peer (DESIGN-DOOR §3): one stderr line per peer and reason, deduped per process
        else if (e.kind === JK.doorReject || e.kind === JK.contractReject) sayRefusal(name, node, e, clientOnly)
        //! M6: a view install re-gathers the LIVE union against the new ring (the Q3a leg) — but
        // ONLY when the gather was ever consumed (M6-review finding 41): `gather` stays null until
        // read()/`await data` materializes it, so an idle scoped cluster pays nothing on churn
        else if (e.kind === JK.viewInstall && gather) void gather.refresh(rt, { throwOnPartial: false, want: false }).catch(() => {})
      }
      if (node.primary !== lastPrimary) {
        lastPrimary = node.primary
        primaryMoved = true
        if (caller && node.primary !== null) caller.onPrimaryChange()
      }
      if (events.some((e) => FOLD.has(e.kind))) refold = true
      if (lost) {
        refold = true
        //! a lost linkDown: reap every stream whose link is gone
        host!.reapGone((id) => { const l = node.links.get(id); return l !== undefined && !l.dead })
        //! a lost shed: a row this node still shows whose partition the kernel no longer has at all —
        // no scope entry and no cell — left lawfully; mirror it out (a lost acquire only undercounts).
        // The kernel mints an entry for every armed cell (verdict, mintHeld, rescope) and drops both
        // together (#shed), so the cell half is a guard: if that ever breaks, a row stays, never goes.
        if (node.armed) {
          const kept = new Set<string>(node.scope!.entries.keys())
          for (const k of node.state.keys()) kept.add((JSON.parse(k) as string[])[0] ?? '')
          for (const p of Object.keys(snapshotOf(bind.data) as object)) if (!kept.has(p)) { shedEver++; bind.shedPartition(p) }
        }
        //! a lost view install: re-gather against the ring, as the install would have
        if (gather) void gather.refresh(rt, { throwOnPartial: false, want: false }).catch(() => {})
      }
    }
    //! cluster.partitions: ONE O(P) recompute per fold() invocation, AFTER the event loop (M6-review
    // finding 42: the tallies + shedWaitingOn walk used to run once for the scope.n drift check and
    // AGAIN in the FOLD branch — coalesced here so each fold pays the walk at most once, and the row
    // still reflects the final post-step state). The scope.n compare catches tally drift that
    // journals nothing (held-mints at the gate/stamp site) — one int compare on the hot path.
    const scopeMoved = node.scope !== null && node.scope.n !== lastScopeN
    //! a client's feeder gate moved (a field compare: the gate's journal rows are the member's, not ours)
    const feederMoved = node.feederOpen !== lastFeederOpen
    if (feederMoved) lastFeederOpen = node.feederOpen
    if (!refold && !scopeMoved && !primaryMoved && !feederMoved) return
    //! a stopping node paints no more frames: the leave ballot installs the shrunk view HERE too, and a
    // screen would end on `writable false — members N−1` — the survivors' picture, not this node's. The
    // housekeeping above (settled writes, reaped streams, the cursor) still runs to the end.
    if (stopping !== null) return
    //! ONE batch, and only the fields that moved (V4-8): a bare `cluster.tap(() => …)` fires once per
    // fold with the whole picture landed — never per field, and never for a refold that changed nothing
    // (data skips a same-value primitive but not an equal-but-new object, so members, peers and the
    // partitions row are compared by signature here). A render loop needs no coalescing and no dedupe.
    // `commit`: a user's cluster tap that throws is reported, and the fold (and the step) still ends.
    commit(fault, () => {
      if (refold || feederMoved || primaryMoved) cluster.set('writable', writableNow())
      if (refold) {
        cluster.set('epoch', node.epoch)
        const memberSig = node.epoch + ':' + node.membership.view.members.map(([u]) => u).join(' ')
        if (memberSig !== lastMembers) { lastMembers = memberSig; cluster.set('members', Object.fromEntries(node.membership.view.members)) }
        //! `client` is the link's ROLE as declared at HELLO (kernel/link.ts): a screen counts its clients
        // with one filter instead of counting a joined server as one. In the signature too, so a
        // same-uuid peer coming back in the other role fires, and an unchanged set still fires nothing.
        const peers: Record<string, { uuid: string; incarnation: number; up: boolean; client: boolean }> = {}
        for (const l of node.links.values())
          if (l.uuid && !l.dead) peers[l.uuid] = { uuid: l.uuid, incarnation: l.incarnation, up: true, client: l.client }
        const peerSig = Object.keys(peers).sort().map((u) => u + '~' + peers[u].incarnation + (peers[u].client ? 'c' : '')).join(' ')
        if (peerSig !== lastPeers) { lastPeers = peerSig; cluster.set('peers', peers) }
      }
      //! the feeder changed (a client's first link, or a failover): `me.primary` names the new one in the
      // same batch, so a screen reads the survivor's name in the picture that shows the link gone
      if (primaryMoved) cluster.set('me', meRow())
      if (node.scope) lastScopeN = node.scope.n
      const row = partitionsRow()
      if (!samePartitions(row, lastPartitions)) { lastPartitions = row; cluster.set('partitions', row) }
    })
  }
  //! the fold is fero's own code: a throw from it is a bug and stays loud (an uncaught error), but it leaves
  // from a microtask, never through the node.step that ran it — a caller that guards its step (the Host's reply
  // and its stream sink) would otherwise take fero's bug for its own failure and swallow it
  rt.hook(() => { try { fold() } catch (e) { queueMicrotask(() => { throw e }) } })
  //! the public cluster handle: the view, with `writes` answered by the ring's own source. A thin Proxy —
  // every other key (snapshot, tap, the operators, [value]) forwards to the data proxy untouched (data's
  // methods close over their own state, never `this`), so `f.cluster.writes.tap(…)` and
  // `f.cluster.writes.snapshot()` work, and `f.cluster.snapshot()` is the picture without the ring.
  const clusterSurface: any = new Proxy(cluster, { get: (t, k) => (k === 'writes' ? writes : Reflect.get(t, k)) })

  //! teardown — everything destroy() does AFTER the graceful leave (V4-6): the local surfaces, the
  // in-flight confirm probes (settled false = could not prove in time — never hang a caller), this
  // instance's directory entry and its hold on the process's shared directory client (unregistered while
  // others share it; the last one out closes it, and the host forgets what is left), then the hosted
  // directory if this instance holds it (⇒ the other servers race for the port), then the runtime.
  // The diagnostics crash() door runs THIS alone: a process death, as the cluster would see it.
  //! `clean` is the leave's verdict (Runtime.leave): it rides through the teardown and is what destroy() resolves —
  // true for a stop that was clean all the way, false past the leave or (scoped) the drain window
  const teardown = async (clean: boolean): Promise<boolean> => {
    bind.destroy()
    host!.destroy()
    caller?.destroy()
    memberCaller?.destroy()
    gather?.destroy()
    for (const [, settle] of probes) settle(false)
    probes.clear()
    await directory?.destroy()
    await rt.destroy()
    return clean
  }
  //! the clean stop is armed HERE, not when compose completes: a SIGINT during a slow start — the listen
  // bind, a durable server's directory round — used to be Node's default (killed by signal: the port
  // bound, a directory entry maybe registered, nothing left or torn down). A provisional entry holds the
  // registry from Runtime construction (no await sits between the two); the instance replaces it at the
  // end of compose. Its stop is the ordinary one — the leave answers at once while nothing holds this
  // node, and a view joined during the directory round still gets its ballot.
  const signals = !isSystem && config.signals !== false
  //! `stopped` settles when that early stop has finished: start() below races it, because a teardown
  // that closes the listen socket before its 'listening' fired leaves the bind promise pending forever
  let stopped!: () => void
  const stoppedP = new Promise<void>((r) => { stopped = r })
  const provisional = { destroy: () => (stopping ??= rt.leave().then(teardown).finally(stopped)) }
  if (signals) track(provisional)
  //! any failure past Runtime construction must tear down what was built — the review caught the
  // leak: a rejected fero() left the bind, the host, and the open WAL fd alive (a listen collision
  // is an ordinary start rejection, not an operator typo). Joins a stop a signal already started.
  const abort = async (err: unknown): Promise<never> => {
    if (signals) untrack(provisional)
    await (stopping ??= teardown(false)).catch(() => {})
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
    //! everything the seed runs of the user's — reading the rows (a getter), the rule, its answer — and the
    // issue itself ends in abort, the resource named: a throw that escaped fero() bare skipped abort's
    // teardown and left the Ctrl-C listener installed (V4-48)
    let recs: Rec[]
    try { recs = Object.entries(config.data as Record<string, unknown>).map(([k, v]) => ({ type: REC.update, key: [k], value: v })) }
    catch (e) { return await abort(new Error(`fero('${name}'): reading the data seed threw: ${errText(e)}`)) }
    //! each row is asked, whole batch first, whether it can be sent (V4-48 — a bigint seed used to start fine
    // and stop replication for good) and what the rule says; a rule that throws aborts like one that refuses
    for (const r of recs) {
      const why = unsendable(r, atCap(rt.node.tune.frame).write)
      if (why !== null) return await abort(new Error(`fero('${name}'): data seed row '${r.key[0]}' cannot be sent: ${why}\n  ${CARRIES}`))
      if (!validate) continue
      let v: unknown
      try { v = validate(r) } catch (e) { return await abort(new Error(`fero('${name}'): data seed row '${r.key[0]}' — validation threw: ${errText(e)}`)) }
      if (v !== true) return await abort(new Error(`fero('${name}'): data seed row '${r.key[0]}' rejected by validation — ${reasonOf(v)}`))
    }
    let out: ReturnType<Bind['issue']>
    try { out = bind.issue(recs) } catch (e) { return await abort(new Error(`fero('${name}'): the data seed could not be issued: ${errText(e)}`)) }
    for (const r of out)
      if (typeof r === 'string') return await abort(new Error(`fero('${name}'): data seed refused by the kernel — ${r}`))
  }
  try {
    await Promise.race([rt.start(), stoppedP])
  } catch (err) {
    //! a stop that closed the socket before it listened rejects start() typed 'stopped': that IS the stop
    // path (the instance resolves stopped below), never an abort — abort would untrack and reject fero().
    // Wait for that stop to finish, so fero() still resolves only once the teardown is done.
    if (stopping !== null) await stoppedP
    else await abort(err) // an explicit listen that would not bind (EADDRINUSE …) — the default is port 0, which cannot collide
  }
  //! a signal during start already stopped this node (the provisional entry above): build nothing more —
  // the instance resolves stopped, its destroy() joins that stop, and the signal handler exits the process
  if (stopping === null) {
    fold()
    //! the directory (V4-3): wired AFTER start, so a port-0 server registers its REAL address. Servers
    // register and attempt to host; every dialable instance looks its name up live; the folded address
    // set posts as `discover` (the kernel dials/parks) and re-folds cluster.me.hosts.
    if (meets) {
      directory = new Directory({
        compose: systemCompose,
        addr: rendezvous as string, name, uuid: node.uuid,
        listen: () => (isClient ? undefined : node.listen),
        serve: !isClient, boxes,
        heartbeatMs: rtOpts.heartbeatMs as number, redialMs: rtOpts.redialMs,
        onHosts: (hs) => { discovered = hs; node.step({ kind: 'discover', hosts: hs }); if (stopping === null) commit(fault, () => cluster.set('me', meRow())) },
        onState: () => { if (stopping === null) commit(fault, () => cluster.set('me', meRow())) },
      })
      try { await directory.start() } catch (err) { await abort(err) }
    }
  }
  cluster.set('me', meRow())

  const inst: Fero = {
    name,
    data: dataSurface,
    methods: methodSurface,
    cluster: clusterSurface,
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
    //! a crash is never a clean stop: no leave, no drain — the teardown's verdict is false
    crash: () => { untrack(inst); return teardown(false) },
    rendezvous: () => (directory ? { client: directory.client, host: directory.host, boxes: Object.fromEntries(directory.boxClients) } : null),
    //! tune: the table the node runs with — how a test sees that redial.tries or leave.ms reached the kernel
    tune: () => node.tune,
    //! config (V4-10): every resolved leaf with the layer it came from — the coerced value the composer
    // read, or the effective default ('the default') where one exists; a function shows as '[function]',
    // the hosted methods and the data seed as their names (rows are data, not config)
    config: () => {
      const out: Record<string, { value: unknown; from: string }> = {}
      //! leave.ms's effective default is the tune row in milliseconds at this node's cadence (16 heartbeats: 8000 at 500);
      // with heartbeats off there is no clock and so no window — the row is shown only when the operator set it
      const effective: Record<string, unknown> = { 'heartbeat.ms': rtOpts.heartbeatMs, 'redial.ms': redialMs ?? 100, 'redial.tries': redialTries ?? TUNE.redials, 'leave.ms': leaveMs ?? (rtOpts.heartbeatMs! > 0 ? TUNE.leaveWindow * rtOpts.heartbeatMs! : undefined), 'journal.cap': journalCap ?? 4096, listen: listen ?? config.listen, rendezvous }
      for (const k of CONFIG_LEAVES) {
        const v = k.split('.').reduce<unknown>((o, p) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), config)
        //! secret is a leaf and a group (§15): with only the client key set, `secret` itself is unset
        if (k === 'secret' && plainObject(v)) continue
        const shown = v !== undefined ? v : effective[k]
        if (shown === undefined) continue
        out[k] = {
          //! a diag token is a secret: the door shows WHO may attach, never the token
          value: typeof shown === 'function' ? '[function]' : k === 'methods' || k === 'data' ? Object.keys(shown as object)
            : k === 'diag.allow' ? Object.fromEntries(Object.keys(shown as object).map((who) => [who, '[redacted]']))
            //! the secret is a secret, and so is the client key: the door says that one is set (and where from), or that
            // the door is open on purpose
            : k === 'secret' || k === 'secret.client' ? (shown === false ? false : '<set>') : shown,
          from: v !== undefined ? from(k) : k === 'rendezvous' && envDefault !== false ? 'FERO_RENDEZVOUS' : 'the default',
        }
      }
      return out
    },
  }
  ;(inst as Fero & { [diagnostics]?: Diagnostics })[diagnostics] = diagHandle
  //! the clean stop on Ctrl-C (V4-8): the instance takes the provisional entry's place — tracked first so
  // the listeners never lapse in between — unless a signal already stopped it during start (then nothing
  // live remains to track; the directory is owned and torn down by its host either way)
  if (signals) {
    if (stopping === null) track(inst)
    untrack(provisional)
  }
  return inst
}

export type { Fero, FeroOpts, Guarantee, WriteResolve, WriteReject, Change, WriteOpts, Methods, Partitions, ScopedError, Spawned, SpawnOpts } from './types.ts'
