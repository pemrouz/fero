//! ── api/config — the ONE seam onto optcascade: every place a value can come from, folded into the call (V4-10) ──
// fero(name, opts) takes its config from six layers, highest first:
//
//   --fero.<key> (a launch flag)  >  the call  >  FERO_<KEY> (env)  >  fero.opt.ts|js next to the
//   nearest package.json at or above cwd  >  fero.opt.ts|js in $HOME  >  the composer's default
//
// and, inside every layer, a value scoped to THIS resource beats the global one: `--fero.shop.dir`
// over `--fero.dir`, `FERO_SHOP_DIR` over `FERO_DIR`, `{ shop: { dir } }` over `{ dir }` in a file.
// optcascade (the owner's copts) does the reading and the merge law; this file owns what optcascade
// cannot know: the DECLARED schema (unknown keys throw naming their source), which layer may carry
// which key (a function or a per-instance switch is the call's alone), the coercions a string layer
// needs (`FERO_HOSTS=a,b`, `FERO_RENDEZVOUS=off`), and the provenance `from(key)` the composer puts
// into its error messages and the diagnostics door. The vocabulary is nested lowercase words
// (`heartbeat.ms`, not `heartbeatMs`) so one spelling survives every layer: env keys are lowercased
// and split on `_` by envdeep, flag keys are lowercased at every depth and nest on `.` (optcascade
// >= 1.1.0), and a file is the object itself.
//
// Determinism: `FERO_CONFIG=off` makes resolveConfig return the call alone with ZERO optcascade
// calls — no argv parse, no env walk, no filesystem probe. The test battery runs that way
// (utils/battery.ts); the layer's own suites inject `sources`. The file layer's directory walk is
// memoized per (cwd, home) for the life of the process (optcascade caches the files themselves
// through require(); it re-runs the existsSync walk per call, ~0.7 ms on a 9p mount).
// System resources (the `#directory` client and host) never enter this file: the composer hands
// them their explicit opts.

import copts from 'optcascade'
import { homedir } from 'node:os'
import type { FeroOpts } from './types.ts'

//! Sources — injectable for tests; every field defaults to the real process.
export interface Sources {
  argv?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  //! note — where a one-time deprecation note goes (default: stderr). Each sink hears a note once.
  note?: (line: string) => void
}

//! Resolved — the folded config (FeroOpts-shaped, nested groups) and, per leaf key, where it came from.
export interface Resolved {
  config: FeroOpts
  //! from('heartbeat.ms') → 'the call' | '--fero.heartbeat.ms' | '--fero.shop.heartbeat.ms' | 'FERO_HEARTBEAT_MS'
  // | 'FERO_SHOP_HEARTBEAT_MS' | 'a fero.opt.ts file (heartbeat.ms)' | … | 'the default' (nothing set it)
  from: (key: string) => string
}

//! ── the declared schema ──────────────────────────────────────────────────────
// Leaves are dotted paths. `layers` says which layers may carry the key: f = flag, c = call, e = env,
// p = file ("paper"). Anything not listed here is unknown and throws — from every layer. `object` marks
// the one leaf whose VALUE is a plain object; at every other leaf an object is a longer name folded
// under it (`FERO_DIR_OLD`) and is refused. The tables are null-prototype objects: a key named
// `constructor` or `toString` must look up NOTHING.
const table = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o)
const LEAVES = table<{ layers: string; why?: string; object?: true }>({
  uuid: { layers: 'fce', why: 'one shared file would give every process the same identity' },
  server: { layers: 'fcep' },
  listen: { layers: 'fcep' },
  hosts: { layers: 'fcep' },
  dir: { layers: 'fcep' },
  'heartbeat.ms': { layers: 'fcep' },
  'redial.ms': { layers: 'fcep' },
  'redial.tries': { layers: 'fcep' },
  'journal.cap': { layers: 'fcep' },
  replicas: { layers: 'fcep' },
  rendezvous: { layers: 'fcep' },
  //! diag.allow — the DIAG channel's allowlist, name → bearer token (kernel NodeOpts.diag). An OBJECT
  // value: `FERO_DIAG_ALLOW_OPS=tok` nests to { ops: 'tok' }. Never a flag: a secret on the command line
  // is readable by every user on the box (`ps`), so the flag layer refuses it with its own message.
  'diag.allow': { layers: 'cep', why: 'a secret never rides the command line', object: true },
  //! secret — the cluster's shared secret (DESIGN-DOOR §5): the call, FERO_SECRET (per resource
  // FERO_SHOP_SECRET) or a fero.opt.ts file. The same carriers as diag.allow, for the same reason.
  secret: { layers: 'cep', why: 'a secret never rides argv: ps, /proc/<pid>/cmdline and shell history show every flag' },
  //! secret.client — the derived client key (DESIGN-DOOR §15): what a process that may only FOLLOW holds instead
  // of the secret. The same layers and the same why. `secret` is a leaf AND a group (secret: '…' or
  // secret: { client: '…' }); the walk visits an object under it. A process holds one of the two, never both.
  'secret.client': { layers: 'cep', why: 'a secret never rides argv: ps, /proc/<pid>/cmdline and shell history show every flag' },
  data: { layers: 'cp', why: 'an object of rows', object: true },
  methods: { layers: 'c', why: 'functions — and the door: it closes a resource from the source line that hosts it' },
  validation: { layers: 'c', why: 'a function' },
  //! the pre-promotion spelling of `validation`, kept for one release: folded into `validation` below,
  // with a one-time note on stderr (the leaf stays declared so the old spelling is not an unknown key)
  'seams.validation': { layers: 'c', why: 'a function' },
  signals: { layers: 'c', why: 'V4-8: the clean stop is per instance, never per process' },
})
const LEAF_KEYS = Object.keys(LEAVES)
//! GROUPS — the object-valued declared keys (a group holds leaves; a resource may not be named after one).
const GROUPS = new Set(['heartbeat', 'redial', 'journal', 'diag', 'seams'])
//! TOP — every declared top-level name; a name subtree in the global layer must not collide with one.
const TOP = new Set([...GROUPS, ...LEAF_KEYS.filter((k) => !k.includes('.'))])
//! RENAMED — the pre-V4-10 spellings, refused with the pointer (lowercased: env arrives that way).
const RENAMED = table<string>({ heartbeatms: 'heartbeat.ms', redialms: 'redial.ms', journalcap: 'journal.cap' })
//! firstLeaf — the leaf a group holds (each group holds one today; the hint names it)
const firstLeaf = (group: string): string | undefined => LEAF_KEYS.find((l) => l.startsWith(group + '.'))
const own = (o: object, k: string): boolean => Object.hasOwn(o, k)

//! ── spellings ────────────────────────────────────────────────────────────────
type Layer = 'flag' | 'call' | 'env' | 'file'
const LAYER_CODE: Record<Layer, string> = { flag: 'f', call: 'c', env: 'e', file: 'p' }
//! spell — where a value came from: how `path` is written in `layer`, scoped to `name` (null = the
// global rung). The call is simply 'the call'.
const spell = (layer: Layer, name: string | null, path: string): string => {
  const scoped = [name, path].filter((x) => x !== null && x !== '').join('.')
  switch (layer) {
    case 'flag': return scoped === '' ? '--fero' : `--fero.${scoped}`
    case 'env': return scoped === '' ? 'FERO' : `FERO_${scoped.replace(/\./g, '_').toUpperCase()}`
    case 'file': return scoped === '' ? 'a fero.opt.ts file' : `a fero.opt.ts file (${scoped})`
    case 'call': return 'the call'
  }
}
//! hint — a spelling to SUGGEST: the same as spell, except that in the call a dotted leaf is shown
// as the object it is (`heartbeat: { ms: … }`)
const hint = (layer: Layer, name: string | null, path: string): string => {
  if (layer !== 'call') return spell(layer, name, path)
  const [g, l] = path.split('.')
  return l === undefined ? g : `${g}: { ${l}: … }`
}

//! nameKey — the per-resource rung's key: the name lowercased, when it can be spelled in every layer
// (env cannot carry a dash or a space, and `_` is envdeep's separator) and does not collide with a
// declared top-level key (`fero('journal')` would read the group). null = the global rung only.
export const nameKey = (name: string): string | null => {
  const k = name.toLowerCase()
  return /^[a-z0-9]+$/.test(k) && !TOP.has(k) ? k : null
}

//! ── reading the layers ───────────────────────────────────────────────────────
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

//! scrub — the two env names that are not config: FERO_CONFIG (this file's own switch) and
// FERO_DIAG_TOKEN (the debug viewer's, tools/debug/serve.ts). Compared lowercased: envdeep does.
const NOT_CONFIG = new Set(['fero_config', 'fero_diag_token'])
const scrub = (env: Record<string, string | undefined>): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) if (!NOT_CONFIG.has(k.toLowerCase())) out[k] = env[k]
  return out
}

//! the file layer's resolver, memoized per (cwd, home): one directory walk per process per pair
const fileResolvers = new Map<string, () => unknown>()
const filesOf = (cwd: string, home: string): unknown => {
  const key = cwd + '\0' + home
  let r = fileResolvers.get(key)
  if (r === undefined) { r = copts('fero', undefined, { argv: [], env: {}, cwd, home }); fileResolvers.set(key, r) }
  return r()
}

//! ── the walk: fold one layer's subtree into a flat map of dotted leaf → value, or throw ──
type Flat = Map<string, unknown>

//! nearest — the declared LEAF closest to an unknown key (a group resolves to its leaf, so the hint
// is always something settable); bounded edit distance over a few dozen short strings; a hint only
const distance = (a: string, b: string): number => {
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}
const nearest = (path: string): string | null => {
  let best: string | null = null
  let bestD = 3
  for (const k of [...LEAF_KEYS, ...GROUPS]) {
    const d = distance(path.toLowerCase(), k.toLowerCase())
    if (d < bestD) { bestD = d; best = GROUPS.has(k) ? firstLeaf(k)! : k }
  }
  return best
}
//! groupMiss — an undeclared OBJECT at the top of a global rung is another resource's subtree unless
// it is a near miss of a declared GROUP (the only declared keys that hold objects): `heartbeats`
// beside `heartbeat` is a typo, `orders` beside `order` is a sibling resource
const groupMiss = (k: string): string | null => {
  for (const g of GROUPS) if (distance(k.toLowerCase(), g) <= 2) return firstLeaf(g)!
  return null
}

//! diagFlag — a diag token on the command line: refused in plain words, the variable and the file named
// instead. The message names the KEY only — never the value, which is the secret.
const diagFlag = (resource: string, name: string | null, allow: unknown): never => {
  const who = isPlain(allow) ? Object.keys(allow)[0] : undefined
  const n = who ?? '<name>'
  throw new Error(`fero('${resource}'): a diag token cannot come from a launch flag (${spell('flag', name, 'diag.allow' + (who !== undefined ? '.' + who : ''))}) — every user on this box can read a command line; set ${spell('env', name, 'diag.allow.' + n)}=<token>, or diag: { allow: { ${n}: … } } in the call or a fero.opt.ts file`)
}

//! carriers — the layers a refused key MAY come from, as a phrase: "the call", "the call or a fero.opt.ts
// file", "the call, the environment or a fero.opt.ts file" (a `cep` leaf: diag.allow, secret), "a flag, the
// call or the environment" (uuid). The template used to say "the call only" for every leaf without a file
// layer, which was false for uuid; it names the real carriers now.
const carriers = (layers: string): string => {
  const parts = [...(layers.includes('f') ? ['a flag'] : []), 'the call', ...(layers.includes('e') ? ['the environment'] : []), ...(layers.includes('p') ? ['a fero.opt.ts file'] : [])]
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
}

//! walk — validate `tree` as one layer's contribution and flatten it. `name` is the rung (null =
// global). In the GLOBAL rung of a flag, env or file layer an undeclared OBJECT at the top level is
// another resource's subtree (this resource's own, `mine`, included — its rung was folded already)
// and is skipped, unless it is a near miss of a declared group. Every other unknown key throws,
// naming its spelling in this layer.
const walk = (resource: string, layer: Layer, name: string | null, tree: unknown, out: Flat, mine: string | null): void => {
  if (tree === undefined) return
  if (!isPlain(tree)) throw new Error(`fero('${resource}'): ${spell(layer, name, '')} must be an object of options, not ${JSON.stringify(tree)}`)
  const visit = (node: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue
      const path = prefix === '' ? k : `${prefix}.${k}`
      //! a dotted key in the call or a file is a flat spelling of a nested key: refused, not folded
      if (k.includes('.')) {
        const leaf = own(LEAVES, k) ? k : firstLeaf(k.split('.')[0]) ?? 'heartbeat.ms'
        throw new Error(`fero('${resource}'): unknown option '${k}' from ${spell(layer, name, k)} — nested keys are objects: ${hint(layer, name, leaf)}`)
      }
      const renamed = RENAMED[path.toLowerCase()]
      if (renamed !== undefined) {
        const [g, l] = renamed.split('.')
        throw new Error(`fero('${resource}'): '${path}' is spelled ${g}: { ${l} } since V4-10 — in the call ${g}: { ${l}: … }, as a flag ${spell('flag', name, renamed)}, in the environment ${spell('env', name, renamed)}`)
      }
      if (GROUPS.has(path)) {
        if (path === 'diag' && layer === 'flag') diagFlag(resource, name, isPlain(v) ? v.allow : undefined)
        if (!isPlain(v)) throw new Error(`fero('${resource}'): '${path}' from ${spell(layer, name, path)} is a group, not a value — did you mean ${hint(layer, name, firstLeaf(path)!)}`)
        visit(v, path)
        continue
      }
      //! secret is a leaf AND a group (DESIGN-DOOR §15): a value is the secret, an object holds the client key
      // (secret: { client: '…' }, FERO_SECRET_CLIENT). Every other leaf keeps the longer-name refusal below.
      if (path === 'secret' && isPlain(v)) { visit(v, path); continue }
      const leaf = LEAVES[path]
      if (leaf !== undefined) {
        if (path === 'diag.allow' && layer === 'flag') diagFlag(resource, name, v)
        if (!leaf.layers.includes(LAYER_CODE[layer]))
          throw new Error(`fero('${resource}'): '${path}' cannot come from ${spell(layer, name, path)} — it is set in ${carriers(leaf.layers)} only (${leaf.why})`)
        //! a LONGER name under a leaf — FERO_RENDEZVOUS_UNUSED beside FERO_RENDEZVOUS, --fero.dir.old — arrives
        // as an OBJECT at the leaf (envdeep nests on `_`, flags on `.`). Folded, it won the merge over the good
        // value and the composer's refusal blamed the variable that was right (I-35): refused here instead,
        // naming the longer spelling. The call is typed (a wrong shape there is the composer's own check) and
        // `data` IS an object.
        if (layer !== 'call' && !leaf.object && isPlain(v)) {
          const sub = Object.keys(v)[0]
          const longer = sub === undefined ? path : `${path}.${sub}`
          throw new Error(`fero('${resource}'): unknown option '${longer}' from ${spell(layer, name, longer)} — ${path} takes a value, not a group`)
        }
        out.set(path, v)
        continue
      }
      //! unknown. (A seam keeps its own pre-V4-10 message: the hash/codec/storage seams land with their milestones.)
      if (prefix === 'seams') throw new Error(`fero('${resource}'): unknown seam '${k}' — M5a ships validation; hash/codec/storage land with their milestones`)
      if (layer !== 'call' && name === null && prefix === '' && isPlain(v)) {
        if (k === mine) continue
        const miss = groupMiss(k)
        if (miss === null) continue
        throw new Error(`fero('${resource}'): unknown option '${path}' from ${spell(layer, name, path)} — did you mean ${hint(layer, name, miss)}`)
      }
      const near = prefix !== '' ? firstLeaf(prefix) ?? null : nearest(path)
      throw new Error(`fero('${resource}'): unknown option '${path}' from ${spell(layer, name, path)}${near !== null ? ` — did you mean ${hint(layer, name, near)}` : ''}`)
    }
  }
  visit(tree, '')
}

//! ── coercion: one table for the STRING layers (a flag, a variable, a file) ──
// The call is typed and means what it says — the composer's own checks refuse `server: 1` or a CSV
// `hosts` string there; a layer that can only carry text gets the spellings text needs. An empty
// string anywhere means UNSET: the fold keeps looking down the rungs (a templated `FERO_DIR=` in a
// container must not become a refusal).
const OFF = new Set(['off', 'false', '0'])
const coerce = (resource: string, key: string, raw: unknown, from: string): unknown => {
  const v = typeof raw === 'string' ? raw.trim() : raw
  if (v === '') return undefined
  switch (key) {
    case 'hosts': {
      const parts = Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? x.split(',') : [x])) : typeof v === 'string' ? v.split(',') : null
      if (parts === null) throw new Error(`fero('${resource}'): hosts must be an array of 'host:port' strings (or one comma-separated string)${src(from)}`)
      const hosts = parts.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '')
      return hosts.length === 0 && !Array.isArray(v) ? undefined : hosts
    }
    case 'rendezvous':
    case 'listen':
      if (v === false || v === 0) return false
      if (typeof v === 'string' && OFF.has(v)) return false
      return v
    case 'server':
      if (v === 1 || v === '1' || v === 'true' || v === true) return true
      if (v === 0 || v === '0' || v === 'false' || v === false) return false
      return v
    case 'diag.allow': {
      //! name → token. A variable carries text, and envdeep reads it: a value that looks like a number or a
      // boolean (`0123`, `1e5`, `Infinity`, `true`) arrives coerced, its text lost, and an `_` in the name nests
      // (FERO_DIAG_ALLOW_OPS_TEAM is `ops` with `team` under it). Each is refused in words that say what the
      // user typed, naming the VARIABLE, never the value. A file is typed: a wrong shape there is just wrong.
      // An empty token is unset, like an empty value anywhere.
      if (!isPlain(v)) throw new Error(`fero('${resource}'): diag.allow must be an object of name → token${src(from)}`)
      const fromEnv = from.startsWith('FERO_')
      const out: Record<string, string> = {}
      for (const [who, tok] of Object.entries(v)) {
        const t = typeof tok === 'string' ? tok.trim() : tok
        if (t === '') continue
        const variable = `${from}_${who.toUpperCase()}`
        if (fromEnv && isPlain(t)) {
          const sub = Object.keys(t)[0] ?? ''
          throw new Error(`fero('${resource}'): ${variable}_${sub.toUpperCase()} is not a diag name — a name in a variable is one word of letters and digits (an _ nests it); set ${variable}${sub.toUpperCase()}=<token>, or diag: { allow: { ${who}_${sub}: … } } in the call or a fero.opt.ts file`)
        }
        if (fromEnv && (typeof t === 'number' || typeof t === 'boolean'))
          throw new Error(`fero('${resource}'): the diag token in ${variable} reads as a number or a boolean, so its text is lost (a leading zero, 1e5, true) — give it a letter`)
        if (typeof t !== 'string') throw new Error(`fero('${resource}'): diag.allow.${who} must be a token string${src(from)}`)
        out[who] = t
      }
      return Object.keys(out).length === 0 ? undefined : out
    }
    case 'uuid':
    case 'dir':
      if (typeof v === 'number')
        throw new Error(`fero('${resource}'): ${key} looks like a number (${v})${src(from)} — a flag or an env value that is all digits loses its leading zeros; give it a letter, or set it in the call`)
      return v
    case 'secret':
      //! the OFF set (and the 0 / false envdeep makes of it) means `false`: open on purpose. Everything else
      // must be text of SECRET_MIN characters — a number or a boolean lost its text on the way in (a value
      // that is all digits is read as a number), a short one is too weak. The message never carries the
      // value: it is the secret.
      if (v === false || v === 0 || (typeof v === 'string' && OFF.has(v))) return false
      if (typeof v !== 'string' || v.length < SECRET_MIN) throw new Error(secretHint(resource, src(from)))
      return v
    case 'secret.client':
      //! the client key (DESIGN-DOOR §15): text of SECRET_MIN characters (the derived key is 43), trimmed above,
      // '' unset above. No off word — the open door is `secret: false`. The message never carries the value.
      if (typeof v !== 'string' || v.length < SECRET_MIN) throw new Error(clientKeyHint(resource, src(from)))
      return v
    default:
      return v
  }
}
//! src — the provenance suffix for a message: nothing for the call, ` (from FERO_X)` otherwise
export const src = (from: string): string => (from === 'the call' ? '' : ` (from ${from})`)
//! SECRET_MIN — the secret's floor (DESIGN-DOOR §14 Q7): 16 characters. secretHint is the one refusal for a
// secret of the wrong shape, from any layer (the composer uses it for the call); it never prints the value.
export const SECRET_MIN = 16
export const secretHint = (resource: string, at: string): string =>
  `fero('${resource}'): secret must be text of at least ${SECRET_MIN} characters${at} — a value that is all digits is read as a number; openssl rand -base64 24 prints a good one`
//! clientKeyHint — the one refusal for a client key of the wrong shape (§15), from any layer; never the value
export const clientKeyHint = (resource: string, at: string): string =>
  `fero('${resource}'): secret.client must be the client key, text of at least ${SECRET_MIN} characters${at} — fero.clientKey(secret) prints it from the cluster's secret`
//! bothSet — secret and secret.client together, from any two layers: refused, never a silent pick (§15)
const bothSet = (resource: string, a: string, b: string): Error =>
  new Error(`fero('${resource}'): ${a} and ${b} are both set — a process holds one: the secret (a member, or a client trusted with it) or the client key (a client that may only follow); drop one`)
//! secretEnv — the raw environment, before envdeep folds it (§15): FERO_SECRET_CLIENT nests UNDER FERO_SECRET
// (an `_` nests), and the nested one wins, so `FERO_SECRET=a FERO_SECRET_CLIENT=b` would reach the fold as
// { secret: { client: 'b' } } with the secret silently gone — even for an EMPTY FERO_SECRET_CLIENT= (a templated
// variable). So: an empty *_SECRET_CLIENT is dropped here (empty means unset in every layer), and a non-empty one
// beside its own rung's *_SECRET is refused naming both, before anything is lost. Only the global rung and this
// resource's are judged; another resource's pair is its own business (the walk skips its subtree). A pair across
// two rungs (FERO_SECRET and FERO_SHOP_SECRET_CLIENT) survives envdeep and is refused after the fold like every
// both-set case. A name is read here the way envdeep reads it — lowercased, split on `_`, empty parts dropped — so
// FERO_SECRET__CLIENT, FERO__SECRET_CLIENT and FERO_SECRET_CLIENT_ (a templated name with an empty part) are the
// same key to the guard that they are to envdeep; an exact-spelling match let each of them past it, and the secret
// was silently gone (the skeptic's finding on the §15 build).
const envKey = (k: string): string[] => k.toLowerCase().split('_').filter(Boolean)
//! rungOf — the rung of a variable whose segments are ['fero', rung?, ...want]: null = the global rung, a string =
// that resource's rung, undefined = not this key at all
const rungOf = (k: string, want: readonly string[]): string | null | undefined => {
  const s = envKey(k)
  const rung = s.length === want.length + 1 ? null : s.length === want.length + 2 ? s[1] : undefined
  if (rung === undefined || s[0] !== 'fero') return undefined
  const rest = rung === null ? s.slice(1) : s.slice(2)
  return rest.every((x, i) => x === want[i]) ? rung : undefined
}
const secretEnv = (resource: string, env: Record<string, string | undefined>, mine: string | null): Record<string, string | undefined> => {
  const out = { ...env }
  const keys = Object.keys(env)
  for (const k of keys) {
    const rung = rungOf(k, ['secret', 'client'])
    if (rung === undefined) continue
    if ((env[k] ?? '').trim() === '') { delete out[k]; continue }
    if (rung !== null && rung !== mine) continue
    const sibling = keys.find((s) => rungOf(s, ['secret']) === rung && (env[s] ?? '').trim() !== '')
    if (sibling !== undefined) throw bothSet(resource, sibling, k)
  }
  return out
}

//! ── unflatten: dotted leaves back into the FeroOpts shape the composer reads ──
const unflatten = (flat: Flat): FeroOpts => {
  const out: Record<string, unknown> = {}
  for (const [path, v] of flat) {
    if (v === undefined) continue
    const parts = path.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= {}) as Record<string, unknown>
    node[parts[parts.length - 1]] = v
  }
  return out as FeroOpts
}

//! flagClash — two flags where one is a group of the other, the shorter one first (`--fero.secret S
// --fero.secret.client K`, `--fero.heartbeat 5 --fero.heartbeat.ms 7`): minimist cannot nest a key under
// a string and throws a TypeError that QUOTES the first flag's value ("Cannot create property 'client'
// on string 'S'"), and that value is a secret when the flag is one (the V4-32 review). So the clash is
// found from the flag NAMES alone and said in fero's words; no value reaches the message. Undefined =
// no such pair: the error is something else and its own text is passed through.
const flagClash = (argv: string[]): string | undefined => {
  const names: string[] = []
  for (const a of argv) {
    const m = /^--(?:no-)?(fero(?:\.[^=]*)?)(?:=|$)/i.exec(a)
    if (m !== null) names.push(m[1].toLowerCase())
  }
  for (const a of names) for (const b of names) if (b.startsWith(a + '.')) return `--${a} and --${b} clash: a key is a value or a group, never both — set one of them`
  return undefined
}

//! read — one optcascade read with a fero-prefixed error naming the layer (a broken file already
// carries its path); `own` gives fero's own words for a failure it can name — the flag clash above —
// in place of optcascade's text (`optcascade: bad flags — …`, which can carry a value)
const read = (resource: string, what: string, fn: () => unknown, own?: () => string | undefined): unknown => {
  try { return fn() } catch (e) { throw new Error(`fero('${resource}'): could not read ${what} — ${own?.() ?? (e as Error).message}`, { cause: e }) }
}

//! ── resolveConfig — the entry the composer calls once per public fero() ──────
export const resolveConfig = (resource: string, call: FeroOpts, sources: Sources = {}): Resolved => {
  const env = sources.env ?? process.env
  const mode = env.FERO_CONFIG?.trim().toLowerCase()
  if (mode !== undefined && mode !== '' && mode !== 'on' && mode !== 'off')
    throw new Error(`fero('${resource}'): FERO_CONFIG='${env.FERO_CONFIG}' — it is 'off' (the call alone), 'on', or unset`)
  const mine = nameKey(resource)
  //! the call is folded and checked the same way as every layer (nested groups, unknown keys, the
  // carriers table) so a typo in code and a typo in a shell get the same message
  const callFlat: Flat = new Map()
  walk(resource, 'call', null, call, callFlat, null)
  const rungs: { layer: Layer; name: string | null; flat: Flat }[] = []
  const add = (layer: Layer, name: string | null, tree: unknown): void => {
    const flat: Flat = new Map()
    walk(resource, layer, name, tree, flat, name === null ? mine : null)
    rungs.push({ layer, name, flat })
  }
  if (mode === 'off') {
    rungs.push({ layer: 'call', name: null, flat: callFlat })
    //! a secret in the environment with the layer OFF is ignored like every variable — said once per process
    // (DESIGN-DOOR §5), so nobody believes a box is locked when it runs open (the battery runs this way)
    const stray = Object.keys(env).find((k) => /^FERO_(?:[A-Z0-9]+_)?SECRET(?:_CLIENT)?$/i.test(k) && (env[k] ?? '').trim() !== '')
    if (stray !== undefined) noteOnce(sources.note ?? toStderr, `FERO_CONFIG=off: ${stray} is ignored, this process runs open\n`)
  } else {
    const argv = sources.argv ?? process.argv.slice(2)
    const scrubbed = secretEnv(resource, scrub(env), mine)
    //! the working directory can be gone (deleted under a running process): then the project file
    // layer is $HOME's — no file, not a raw ENOENT
    let cwd: string
    try { cwd = sources.cwd ?? process.cwd() } catch { cwd = sources.home ?? homedir() }
    //! three optcascade reads, one per layer, each with the other sources emptied — so every value
    // has exactly one origin and the fold above can name it; the name rung is that layer's [mine]
    const flags = read(resource, 'the launch flags', () => copts('fero', undefined, { argv, env: {}, files: false })(), () => flagClash(argv))
    const envs = read(resource, 'the environment', () => copts('fero', undefined, { argv: [], env: scrubbed, files: false })())
    const files = read(resource, 'a fero.opt.ts file', () => filesOf(cwd, sources.home ?? homedir()))
    const sub = (tree: unknown): unknown => (mine !== null && isPlain(tree) && own(tree, mine) ? tree[mine] : undefined)
    add('flag', mine, sub(flags))
    add('flag', null, flags)
    rungs.push({ layer: 'call', name: null, flat: callFlat })
    add('env', mine, sub(envs))
    add('env', null, envs)
    add('file', mine, sub(files))
    add('file', null, files)
  }
  //! the merge: per leaf, the first rung that carries it wins (flags scoped, flags, the call, env
  // scoped, env, file scoped, file); arrays and objects replace whole, exactly optcascade's law
  const flat: Flat = new Map()
  const origin = new Map<string, string>()
  const value = (r: (typeof rungs)[number], key: string): { v: unknown; from: string } | null => {
    if (!r.flat.has(key)) return null
    const from = spell(r.layer, r.name, key)
    const v = r.layer === 'call' ? r.flat.get(key) : coerce(resource, key, r.flat.get(key), from)
    return v === undefined ? null : { v, from } // '' = unset: keep looking down the rungs
  }
  for (const key of LEAF_KEYS) {
    for (const r of rungs) {
      const got = value(r, key)
      if (got === null) continue
      flat.set(key, got.v)
      origin.set(key, got.from)
      break
    }
  }
  //! the client pin is STICKY (V4-10): `server: false` anywhere refuses `server: true` from a higher
  // rung — a process that means to follow cannot be flipped by a stray flag; the composer refuses the
  // other markers (listen, dir, replicas, data, methods) naming both sources
  if (flat.get('server') === true) {
    for (const r of rungs) {
      const got = value(r, 'server')
      if (got !== null && got.v === false)
        throw new Error(`fero('${resource}'): server: true${src(origin.get('server')!)} but server: false pins the client role${src(got.from)} — drop one`)
    }
  }
  //! secret and secret.client together (§15), from any two layers: a process holds ONE — refused naming both
  // sources (unflatten could not even hold both: the leaf and the group share a name)
  if (flat.has('secret') && flat.has('secret.client'))
    throw bothSet(resource, `secret${src(origin.get('secret')!)}`, `secret.client${src(origin.get('secret.client')!)}`)
  //! seams.validation → validation (owner question 5, 2026-10-05): the one function-valued config key is
  // a top-level key now. The old spelling is folded into the new one for one release, with a note once
  // per process; both at once is one key set twice, refused rather than silently picking one.
  if (flat.has('seams.validation')) {
    if (flat.has('validation')) throw new Error(`fero('${resource}'): validation and seams.validation are one key, set twice — keep validation and drop seams`)
    flat.set('validation', flat.get('seams.validation'))
    origin.set('validation', origin.get('seams.validation')!)
    flat.delete('seams.validation')
    origin.delete('seams.validation')
    noteOnce(sources.note ?? toStderr, `fero('${resource}'): seams: { validation } is now spelled validation: — the old spelling still works in this release and goes in the next\n`)
  }
  return { config: unflatten(flat), from: (key) => origin.get(key) ?? 'the default' }
}

//! noteOnce — each sink hears a given note once: the real process has one sink (stderr), so a note
// prints once per process however many resources it composes; a test injects its own sink
const toStderr = (line: string): void => { process.stderr.write(line) }
const noted = new WeakMap<(line: string) => void, Set<string>>()
const noteOnce = (sink: (line: string) => void, line: string): void => {
  const key = line.replace(/^fero\('[^']*'\): /, '')
  let seen = noted.get(sink)
  if (seen === undefined) noted.set(sink, (seen = new Set()))
  if (seen.has(key)) return
  seen.add(key)
  sink(line)
}

//! CONFIG_LEAVES — the declared leaves, exported for the docs drift test (README's table must name each)
export const CONFIG_LEAVES: readonly string[] = LEAF_KEYS
