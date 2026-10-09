# DESIGN-CONFIG — one config door: optcascade under fero() (V4-10)

*Status: the study (2026-09-15) and the decisions it led to (2026-09-19,
§11). The landing is DECISIONS V4-10; this document is its record. The study's
code claims were checked against the tree at `fc6201c` and against copts at
`../copt` by running it; copts has since been published as `optcascade` 1.0.0
(the same API). Where the study and §11 differ, §11 is what was built.*

## §11 What was decided and built (2026-09-19)

The owner read the study and settled the open questions:

- **Nested lowercase keys, not camelCase.** `heartbeatMs` → `heartbeat.ms`,
  `redialMs` → `redial.ms`, `journalCap` → `journal.cap`. One spelling then
  survives every layer (env keys are lowercased and split on `_`; flags nest on
  `.`; a file is the object itself), so the case-fold the study designed is
  not needed. The old spellings are refused with a pointer to the new one, from
  every layer. BREAKING within 4.x, like V4-3.
- **The pre-check, validation, parsing and coercion layer** as designed (§2,
  §3), in `api/config.ts`. Coercions apply to the STRING layers only (a flag, a
  variable, a file); the call is typed and the composer refuses `server: 1` or
  a CSV `hosts` string there.
- **Per-resource scoping** as designed (§3): `--fero.shop.dir`,
  `FERO_SHOP_DIR`, `{ shop: { dir } }` beat the global rung inside every layer.
- **`server: false` from ANY layer** is the client pin (the study said the
  call only): the same key means the same thing in every layer.
- **The package is `optcascade` on npm** (1.0.0). fero depends on it by
  version: its first `dependencies` entry, `engines.node >= 22.18`, and an
  `npm install` before the first run. No copt-side change was needed for the
  landing; the 1.1 wishes (§9) stay filed.
- **`diag` stays deferred** (§4); the kernel tune table was a later series (landed 2026-10-08, §7 step 7).
- **The review before landing (four adversarial lenses, 26 findings) changed
  four rules from the study:** the near-miss test in the global rung applies
  only to declared GROUPS (`heartbeats` beside `heartbeat` throws; a sibling
  resource one edit away, `order` beside `orders`, is left alone, and a
  resource named `host` keeps its own rung); the client pin is sticky
  (`--fero.server` over the call's `server: false` is refused); an empty
  string from any string layer means unset; a dotted key in the call or a
  file is refused as the flat spelling of a nested key. The schema tables are
  null-prototype (`constructor` is an unknown key, not a crash), a flag's key
  is read lowercased at every depth like a variable's (optcascade >= 1.1.0:
  `--FERO.dir` is `--fero.dir`, neither ignored nor refused), and the battery
  pins by plain assignment.

Precedence, as built: `--fero.<key>` > the call > `FERO_<KEY>` > `fero.opt.ts`
at the project > `fero.opt.ts` in `$HOME` > the default; inside every layer the
resource's own rung beats the global one. `FERO_CONFIG=off` reads the call
alone (the battery, `utils/battery.ts`).

## The question

The old fero (v1, `../fero`) took every tunable through `copt('fero', {…})`
and ended its README with one table: Key | Default | Description, settable
from the command line, from the call, or by default. fero v4 takes fourteen
keys through `fero(name, opts)` and reads exactly two environment variables
anywhere: `FERO_RENDEZVOUS` (api/directory.ts) and `FERO_DIAG_TOKEN` (the
debug viewer, consumer side only). Can copts give v4 the same one door, and
for which parameters?

## §0 The answer

**Yes for the keys `fero()` already takes.** One new file, `api/config.ts`,
is the only importer of copts (the way `api/substrate.ts` is the only importer
of data). It runs once per public `fero()` call, before the composer's
existing validation, and gives every scalar key four spellings: the call,
`--fero.<key>`, `FERO_<KEY>`, and a `fero.opt.ts` file. No kernel change. No
hot-path change. No new entry in `package.json` (a sibling import, like data).

**No for "every parameter" in the old fero's sense.** The kernel's constants
(suspect ticks, queue bounds, compaction triggers, backoff caps) are module
constants read per record, per frame, or per tick. Exposing them means a
`NodeOpts` field, a read site change on hot paths, and a perf A/B. That is a
kernel series of its own (§7, "the tune table"). This landing keeps them fixed
and says so in the table.

**Four things copts does not do for fero's key shapes**, found by running it
(§2): env keys are lowercased so `heartbeatMs` is unreachable from env;
undeclared keys leak through the prefix and would trip fero's unknown-key
throw; CSV and `off`/`0` spellings arrive as the wrong type; the file layer
costs a filesystem walk and would let a `$HOME` file reach the test battery.
Each has a small fix in `api/config.ts`. Two of them could move into copts
itself later (§9).

## §1 What copts gives

`copts('fero', defaults, sources)` returns a resolver; `resolver(opts)` merges
the `fero` subtree of every source, highest priority first:

| Layer | Spelling |
|---|---|
| CLI flags | `--fero.heartbeatMs 250`, `--no-fero.rendezvous`, repeated `--fero.hosts a --fero.hosts b` collects |
| opts (the call) | `fero('shop', { heartbeatMs: 250 })` |
| env | `FERO_HEARTBEATMS=250` (keys lowercased, split on `_`; `'5'`→5, `'true'`→true, `'off'` stays a string) |
| `fero.opt.ts` / `fero.opt.js` | in the nearest directory at or above cwd that holds a `package.json` (none found = layer skipped silently) |
| `fero.opt.ts` / `fero.opt.js` | in `$HOME` |
| defaults | the second argument |

Per key the first layer that defines a value wins. Plain objects merge key by
key; a scalar or array cuts the merge. Sources are injectable
(`{argv, env, cwd, home, files: false}`), so the layer is testable without
touching the real process. argv and env are read on every call; files load
once per process through `require()` (a `.ts` file needs Node ≥ 22.18 or the
strip-types flag every npm script already passes). A dotted prefix selects a
subtree: `copts('fero.shop', …)` reads `--fero.shop.x`, `FERO_SHOP_X`, and
`shop.x` from the files. `copts.async` exists for files with top-level await.

copts is at `../copt`. It is **not on npm** (`npm view copts` and `copt` both
404; minimist and envdeep resolve, and envdeep 1.0.0 is published). The repo
has no git remote. Its 19 tests pass on this box (Node 26.1).

## §2 The four problems, each with its fix

Measured by running copts against fero's real key shapes (scratch scripts,
this session).

**1. Env can never reach a camelCase key.** `FERO_HEARTBEATMS=999` produced a
NEW key `heartbeatms: 999` next to the default `heartbeatMs: 500`. CLI flags
keep their case, so `--fero.heartbeatMs 250` works. Three keys are camelCase:
`heartbeatMs`, `redialMs`, `journalCap`.
*Fix.* `api/config.ts` reads each layer separately through copts' injectable
sources (flags with env emptied, env with argv emptied, files with both
emptied) and folds every key of every layer through one lowercase→declared map.
So `--fero.heartbeatms`, `FERO_HEARTBEATMS`, and a file's `heartbeatms` all
land on `heartbeatMs`. One rule for every layer. A layer that carries BOTH
spellings (`--fero.heartbeatMs 1 --fero.heartbeatms 2`) throws as ambiguous,
the way copts already refuses both `fero.opt.ts` and `fero.opt.js`.
*Note.* copts' no-prefix form already does declared-key, case-insensitive env
matching (`src/index.ts:127`, `parsed[k.toLowerCase()]`): verified,
`copts({heartbeatMs: 500}, {env: {HEARTBEATMS: '9'}})()` gives `heartbeatMs: 9`
and drops undeclared names. Giving the prefixed form the same mode (§9) would
let fero delete its fold.

**2. Undeclared keys leak, and fero throws on unknown keys.** In prefixed mode
copts returns everything under `fero`: `FERO_DIAG_TOKEN=sekrit` (a variable
real shells export for the debug viewer) produced `diag: {token: 'sekrit'}`.
Fed to the composer as-is, one stray variable breaks every `fero()` in that
shell (api/index.ts:88).
*Fix.* The layer checks every key of every layer against the declared schema
before the composer sees anything. An unknown key throws naming its source and
the nearest declared key: `fero('shop'): unknown option 'heartbeat.ms' from
FERO_HEARTBEAT_MS — did you mean FERO_HEARTBEATMS`. Two env names are
reserved and stripped before copts sees the environment: `FERO_CONFIG` (the
layer switch, §3) and `FERO_DIAG_TOKEN` (the viewer's variable, documented as
not fero config). Silently ignoring unknown env names was considered and
rejected: a typo would do nothing and say nothing, while flags and files throw.
The composer's own unknown-key loop stays as the last gate.

**3. String coercions.** `FERO_HOSTS=x:1,y:2` stays one string (fero wants
`string[]`, and `hosts.some(…)` would throw a TypeError). `FERO_SIGNALS=0`
becomes the number 0 (fero wants a boolean). `FERO_RENDEZVOUS=off` arrives as
the string `'off'`, which the key validator refuses; only `rendezvousDefault()`
(api/directory.ts:48) understands `off`/`false`/`0`, and only on the raw env
path. `FERO_RENDEZVOUS=false` becomes boolean `false` (fine). `FERO_REPLICAS=2`
becomes 2 (fine). `--no-fero.rendezvous` gives `false` (fine).
*Fix.* One per-key coercion table in `api/config.ts` (§3), applied to the
merged value whatever its layer, then the composer's existing shape checks.
The composer gains three checks it lacks today, because env makes non-numbers
reachable: `heartbeatMs`/`redialMs` finite and ≥ 0, `journalCap` an integer
≥ 1. (Today `heartbeatMs: 'abc'` silently turns heartbeats off:
kernel/node.ts:412 is `(opts.heartbeatMs ?? 0) > 0`.)

**4. The file layer's cost and reach.** 1000 resolves with `files: false` took
15 ms (≈15 µs each). With the file layers on and no file present, 680 ms
(≈0.7 ms each): copts runs the `existsSync` walk up to `package.json` on every
construction (`src/index.ts:107, 152-157`), and this box is WSL2 on `/mnt/c`.
A `fero.opt.ts` in `$HOME` reaches every `fero()` of that user on the box, the
test battery included. Files are cached per process, so editing one needs a
restart, and a file that throws breaks every `fero()` with its path in the
error (copts `fail(e, path)`).
*Fix.* `FERO_CONFIG=off` makes `resolveConfig` return the call untouched with
zero copts calls. One module, `utils/battery.ts`, sets `FERO_CONFIG=off` and
`FERO_RENDEZVOUS ??= 'off'`; it is the first import of the seven suites that
call `fero()` (api/diagnostics, api/directory, api/index, api/methods,
api/scoped, tests/api-scenarios, tests/scale-tcp) and rides `--import
./utils/battery.ts` in the `test`, `perf` and `perf:alloc` scripts. The
examples tier (tests/examples.test.ts) never calls `fero()`; it spawns
`check.ts` children with `{ env: { ...process.env, FERO_RENDEZVOUS } }` and no
`execArgv`, so the checks and their roles are isolated by the inherited
`FERO_CONFIG=off` in the environment alone, not by the import. In production,
`api/config.ts` memoizes the files resolver per `(cwd, home)` so a process
composing many resources pays the walk once (copts itself does not memoize).
System composes (the `#directory` client and host) never enter the layer.

## §3 The design

### Where copts is called

`api/config.ts` exports `resolveConfig(name, call, sources?) → { config,
from }`. `config` is a FeroConfig-shaped bag. `from(key)` names the layer that
won: `'the call'`, `'--fero.<key>'`, `'FERO_<KEY>'`, or `'a fero.opt.ts
file'`. It is called inside `compose()` (api/index.ts) only when `isSystem` is
false, before the existing validation loop. The loop then validates the merged
bag exactly as today. Every existing message that names a key gets the source
appended when the value did not come from the call: `listen must be a
'host:port' string … (from FERO_LISTEN)`. The legacy `FERO_RENDEZVOUS='garbage'
is not a 'host:port' address (or 'off')` text is kept verbatim so
api/directory.test.ts:149 stays green.

The reads, per public `fero()`:

```ts
if (env.FERO_CONFIG === 'off') return { config: call, from: () => 'the call' }   // zero copts calls
const flags = copts('fero', undefined, { argv, env: {}, files: false })()          // flags only
const envL  = copts('fero', undefined, { argv: [], env: scrubbed, files: false })() // env only
const files = filesResolver(cwd, home)()   // memoized per (cwd, home); project beats home inside copts
```

Each layer is folded (lowercase → declared spelling), checked against the
schema (unknown keys throw naming the source), checked against the carriers
table (which layers may carry which key), then merged with a plain `??` chain
per key: flag, call, env, file. Every layered key is a flat scalar or one array
(`hosts`), so no deep-merge law needs restating. The coercion table runs on the
merged value. The composer's `??` lines stay the only defaults, so no layer can
arm a protocol mode the user did not ask for.

`rendezvous` keeps one special rung. The layer strips `FERO_RENDEZVOUS` from
what copts sees and reads it itself through a shared normalizer (`rendezvousOf`,
exported next to `rendezvousDefault`). This keeps env above files: today
api/index.ts:139 consults the env var only when the key is undefined, so
without this a file's `rendezvous` would beat the battery's
`FERO_RENDEZVOUS=off`. With `FERO_CONFIG=off` the composer's existing env path
runs unchanged, which is what api/directory.test.ts:104-150 exercises by
mutating `process.env`. examples/lib.ts sets `FERO_RENDEZVOUS` at runtime
before `fero()`; copts reads env per call, so that keeps working under both
modes.

### Precedence

`--fero.<key>` (flag) > the call > `FERO_<KEY>` (env) > `fero.opt.ts` at the
project > `fero.opt.ts` in `$HOME` > the composer's default.

This keeps the settled V4-3 rule (key > `FERO_RENDEZVOUS` > constant) and adds
ONE rung above the code: a flag typed at launch beats the call. That is copts'
own law and the old fero's idiom (`--constants.outbox.max`). It is what makes
`node server.ts --fero.dir ./a` work with no code edit. It is new, and
DECISIONS must say so (§10, Q1).

### Per-resource scoping

A process that composes two resources (`fero('shop')` and `fero('users')`)
would read the same `FERO_LISTEN`, `FERO_DIR`, `FERO_UUID` for both: the same
port (EADDRINUSE), the same WAL dir (two nodes, one identity), the same uuid.
copts' dotted prefix answers this at no cost: read `copts('fero.' + name, …)`
beside `copts('fero', …)` in every layer, and inside each layer let the named
value beat the global one. Spellings: `--fero.shop.listen`, `FERO_SHOP_LISTEN`,
and `{ shop: { listen } }` in `fero.opt.ts`. The name is matched lowercased.
Names that are not `[a-z0-9]+` after lowercasing (spaces, dashes, `_`, `#`)
get only the global rung and the call, stated in the error hint. In the global
layer an object-valued key that is not declared is treated as a per-name
subtree and is skipped, not thrown (unknown SCALAR keys still throw). This is
the one softening of "unknown keys throw", and it is confined to objects.
Landed (§11): without it the env and CLI layers are unusable for any
multi-resource process.

### The key vocabulary

*(The study proposed keeping camelCase with a case-fold; §11 chose nested
lowercase keys instead, so the three camelCase rows below read `heartbeat.ms`,
`redial.ms`, `journal.cap` as built: `--fero.heartbeat.ms 250`,
`FERO_HEARTBEAT_MS=250`, `heartbeat: { ms: 250 }` in the call and in a file.
No fold: matching is exact, and a lowercase shell variable reads because
envdeep lowercases every env key.)*

| Current key | Call | CLI | Env | File (`fero.opt.ts`) |
|---|---|---|---|---|
| `uuid` | `uuid: 'a1'` | `--fero.uuid a1` | `FERO_UUID=a1` | refused (one shared file would give every process one identity) |
| `server` | `server: true` (and `server: false` as the client pin, step 6) | `--fero.server` | `FERO_SERVER=true` or `1` | `server: true` |
| `listen` | `listen: '127.0.0.1:4000'` or `false` | `--fero.listen 127.0.0.1:4000`, `--no-fero.listen` | `FERO_LISTEN=127.0.0.1:4000` or `off` | `listen: '…'` |
| `hosts` | `hosts: ['a:1','b:2']` | `--fero.hosts a:1,b:2` or repeated | `FERO_HOSTS=a:1,b:2` | `hosts: ['a:1']` |
| `dir` | `dir: './state'` | `--fero.dir ./state` | `FERO_DIR=./state` | `dir: './state'` |
| `heartbeatMs` | `heartbeatMs: 250` | `--fero.heartbeatMs 250` (any case) | `FERO_HEARTBEATMS=250` | `heartbeatMs: 250` (any case) |
| `redialMs` | `redialMs: 200` | `--fero.redialMs 200` | `FERO_REDIALMS=200` | `redialMs: 200` |
| `journalCap` | `journalCap: 65536` | `--fero.journalCap 65536` | `FERO_JOURNALCAP=65536` | `journalCap: 65536` |
| `replicas` | `replicas: 3` | `--fero.replicas 3` | `FERO_REPLICAS=3` | `replicas: 3` |
| `rendezvous` | `rendezvous: '127.0.0.1:4000'` or `false` | `--fero.rendezvous …`, `--no-fero.rendezvous` | `FERO_RENDEZVOUS=…` / `off` / `false` / `0` (unchanged) | `rendezvous: '…'` |
| `data` | `data: { … }` | refused (an object of rows) | refused | `data: { … }` |
| `methods` | `methods: { … }` | refused (functions, and the door) | refused | refused |
| `seams.validation` | `seams: { validation }` | refused (a function) | refused | refused |
| `signals` | `signals: false` | refused (V4-8 rejected a per-process spelling) | refused | refused |

A `fero.opt.ts` is a default export: `export default { heartbeatMs: 250,
shop: { dir: './shop' } }`. copts unwraps `default`, else takes the module.

### Coercion table (owner: `api/config.ts`, applied after the merge)

| Key | Rule |
|---|---|
| `hosts` | a string splits on `,`, trimmed, empties dropped; an array (repeated flag) is flattened the same way |
| `rendezvous`, `listen` | `off`, `false`, `0` (string or number), boolean `false`, and `--no-…` become `false`; `''` becomes unset (for a server: the free-port default); anything else must pass `isAddr` |
| `server` | `1`, `'1'`, `'true'` become `true`; `0`, `'0'`, `'false'` become `false`, the client pin, from any layer (§11) |
| `heartbeatMs`, `redialMs`, `journalCap`, `replicas` | copts already turned digit strings into numbers; the composer requires finite ≥ 0 (heartbeatMs, redialMs) or an integer ≥ 1 (journalCap, replicas) |
| `uuid`, `dir` | a numeric-looking value (`--fero.uuid 12345678`) is refused with advice: minimist and copts turn it into a number and leading zeros are lost |
| `signals`, `data`, `methods`, `seams` | call-only (`data` also from a file); any other layer throws naming the source |
| unknown key, any layer | throws naming `--fero.<x>`, `FERO_<X>`, the call, or the file, with a nearest-key hint |

### Dependency plan

*(Study text; superseded by §11: `optcascade` 1.0.0 is on npm and fero depends
on it by version.)* copts is not on npm; this repo has no remote and no `node_modules`.
`api/config.ts` imports it as a sibling checkout, `import copts from
'../../copt/src/index.ts'`, exactly as `api/substrate.ts` imports
`../../data/api/index.ts`. copts' own `minimist` and `envdeep` resolve from
`../copt/node_modules`, already installed. `package.json` keeps no
`dependencies`. When copts is published the follow-up is one line (the import
becomes `'copts'`) plus a `dependencies` entry, and THAT is the moment fero's
zero-dependency posture is spent; it gets its own DECISIONS line. A
`file:../copt` link was rejected: it forces an `npm install` step fero has
never had. Vendoring was rejected: the owner owns copts, and a copy would fork
the merge law. Add `"engines": { "node": ">=22.18" }` (there is none today;
the examples already assume plain `node server.ts` strips types). A fresh
clone without the `copt` sibling fails at the import of `api/index.ts`, the
same way it does today without `data`; one line in CLAUDE.md.

### Perf plan

`fero()` is construction-time only, and no `*.perf.ts` pin calls it
(verified). Cost per public `fero()` with the layer on: two or four copts
constructions (≈15 µs each) plus one memoized files walk per process (0.7 ms
on `/mnt/c`, microseconds on a native filesystem). With `FERO_CONFIG=off`:
zero. System composes: zero. Nothing on the read, write, replication, tick, or
journal path changes: `rtOpts` is built by the same lines with the same
values, and every `NodeOpts` field stays a plain field. The 41 pins
structurally cannot move; run `npm run perf` on every commit anyway and judge
by structure and back-to-back A/B, never by WSL2 absolutes. Add one advisory
sibling pin, `api/config.perf.ts`: 1000 `resolveConfig` calls with injected
sources and files off under 500 ms (measured ≈15 ms), never to be widened.
data's perf suite is unaffected (no seam change).

## §4 THE TABLE: every parameter that becomes configurable

Scope: *instance* = this node only; *cluster* = must be the same on every
member (the deployer's contract, kernel/node.ts:74); *process* = one value for
the whole process. Defaults are the tree's, verified.

### Identity and role

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `uuid` | the dir's saved identity, else 8 random hex chars | instance | call `uuid: 'a1'` · env `FERO_UUID=a1` · CLI `--fero.uuid a1` · file: refused | Names this node. It rides HELLO and stamps every write this node makes. Must be unique per member. On a durable dir it must match the saved identity or `fero()` throws. Never from a file: two processes reading one file would share one identity. |
| `server` | unset (a bare `fero(name)` is a client) | instance | call `server: true` · env `FERO_SERVER=true` · CLI `--fero.server` · file `server: true` | Pins the server role even with no other marker. `listen`, `dir`, `replicas`, `data` and `methods` also make a server. After step 6, `server: false` in the call pins the client role and refuses any server marker from a layer. |
| `data` | unset | instance | call `data: {…}` · file `data: {…}` · env/CLI: refused | Initial rows, applied only when the local fold is empty at boot. Implies the server role. |

### Network and discovery

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `listen` | server: `127.0.0.1:0` (a free loopback port); client: none; `false` = socketless solo | instance | call `listen: '127.0.0.1:4000'` · env `FERO_LISTEN=127.0.0.1:4000` or `off` · CLI `--fero.listen 127.0.0.1:4000` or `--no-fero.listen` · file `listen: '…'` | The address this node binds and tells its peers. When that address would leave the box (`hosts` name another box, or `rendezvous` is not loopback), it must be one another box can dial: a loopback or wildcard listen, the default included, is refused (the explicit-listen rule, DESIGN-DIRECTORY §11). A user resource may never take the rendezvous socket. No layer default is ever routable. |
| `hosts` | unset (the directory's discovered set alone) | instance | call `hosts: ['a:1','b:2']` · env `FERO_HOSTS=a:1,b:2` · CLI `--fero.hosts a:1,b:2` or repeated · file `hosts: […]` | Static addresses to dial on start. Alone on a client they are its feeders; beside a server marker they make a dialing member. The directory's discovered set is unioned in. |
| `rendezvous` | unset, then `FERO_RENDEZVOUS`, then `127.0.0.1:3376`; `false` = no directory | instance (the env var is process-wide) | call `rendezvous: '127.0.0.1:4000'` or `false` · env `FERO_RENDEZVOUS=…` / `off` / `false` / `0` · CLI `--fero.rendezvous …` or `--no-fero.rendezvous` · file `rendezvous: '…'` | The per-box directory this instance registers with and looks names up in. Instances on one box that name different directories never find each other. A bad value is refused at `fero()` time with the source named. |

### Durability

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `dir` | unset (memory only) | instance | call `dir: './state'` · env `FERO_DIR=./state` · CLI `--fero.dir ./state` · file `dir: './state'` | The directory holding `wal.log` and `boot.json` (and, after a boot record failed, a `condemned` marker that refuses the next restart). Presence turns on the WAL, restores the previous life's identity and view, and implies the server role. Two processes on one dir are two lives of one node; keep it per process (per-name scoping, §3). |

### Replication and scoping

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `replicas` | unset (every member holds every partition) | cluster | call `replicas: 3` · env `FERO_REPLICAS=3` · CLI `--fero.replicas 3` · file `replicas: 3` | Scoped replication: each partition lives on exactly this many holders. Integer ≥ 1. Implies the server role. Must be identical on every member; a per-box override is drift the kernel does not police. |

### Membership and timing

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `heartbeatMs` | 500 (0 = off) | cluster | call `heartbeatMs: 250` · env `FERO_HEARTBEATMS=250` · CLI `--fero.heartbeatMs 250` · file `heartbeatMs: 250` | The one clock. Pings, membership ticks (suspicion after 3 ticks, eviction, joins), write retry (2 ticks), compaction, WAL snapshot arming and the leave wait (4 ticks) all run on it. Must match on every member. |
| `redialMs` | 100 | instance | call `redialMs: 200` · env `FERO_REDIALMS=200` · CLI `--fero.redialMs 200` · file `redialMs: 200` | The dial backoff base after a peer drops. Doubles per failure up to 32× the base; gives up after 10 tries (heartbeats revive it). Also the `#directory` client's redial base. |

### Bounds and buffers

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `journalCap` | 4096 | instance | call `journalCap: 65536` · env `FERO_JOURNALCAP=65536` · CLI `--fero.journalCap 65536` · file `journalCap: 65536` | Size of the diagnostics ring. Older events are dropped and counted. Raise it for captures that want full time travel. Integer ≥ 1. |

### Method plane and timeouts

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `methods` | unset (an open resource) | instance | call only | The hosted methods, and the door: declaring them means clients change data only through them. A plain object of functions. Never from a file (it would host code and close the door from outside the source line). The write, call and gather timeouts stay per-call options (§5). |
| `seams.validation` | unset (every relayed write admitted) | cluster | call only | A schema check run on every relayed client write inside the kernel step. Return `true` or a reason string. A function, so no other layer can carry it. Every server must run the same predicate. |

### Process

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `signals` | `true` | process (one listener, set per instance) | call `signals: false` only | Ctrl-C and SIGTERM make every live instance leave cleanly, then the process exits 0 unless the app has its own listener. `false` keeps this instance out. Call-only: V4-8 rejected a per-process spelling, and an env or file value would be one. |
| `FERO_CONFIG` (a switch, not a key) | on | process | env `FERO_CONFIG=off` only | Turns the whole layer off: `fero()` reads only the call and makes zero copts calls. The test battery sets it through `utils/battery.ts`. `FERO_CONFIG=<path>` is not supported; use the file layers. |

### Deferred to its own follow-up: `diag`

`NodeOpts.diag { allow: { name: token } }` exists (kernel/node.ts:82) but is
not a FeroConfig key, so the M7 diagnostics channel's SERVER side is
unreachable from the public `fero()` today: every `npm run debug -- --attach`
against a real cluster is denied. A config layer is the natural home
(`diag: { allow: { alice: 'token' } }`, env `FERO_DIAG_ALLOW_ALICE=token`, CLI
refused because a secret never rides argv). It is deferred out of this landing
for two reasons: it is the one NEW key, and its natural env shorthand
`FERO_DIAG_TOKEN` collides with the viewer's variable of the same name
(§2, problem 2). Land it after, with `FERO_DIAG_TOKEN` stated as the viewer's
only, and with token values redacted from the `from` trace (Q4).

### The door's key: `secret` (landed 2026-10-09, docs/DESIGN-DOOR.md §5)

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `secret` | unset (the open door) | cluster: the same value on every member AND every client | call `secret: '…'` or `false` · env `FERO_SECRET=…` / `off` (per resource `FERO_SHOP_SECRET`) · file `secret: '…'` · CLI: refused, a secret never rides argv | The cluster's shared secret, text of at least 16 characters; the text layers coerce `off` / `false` / `0` to `false` (open on purpose) and refuse a number, a boolean or a short value without echoing it. The kernel gets two functions (an HMAC and a nonce mint), never the string. `diag(f).config()` shows `<set>` with its source, or `false`. With the layer off (`FERO_CONFIG=off`) a `FERO_SECRET` in the environment is ignored like every variable, and the process says so once on stderr. |

The shape §4 gave the deferred `diag` key — the call, the environment or a
file, never a flag, the value redacted from the diagnostics door — is now used
twice: `diag.allow` (landed with M7's config) and `secret`. The carriers
message names the layers a key may come from (`it is set in the call, the
environment or a fero.opt.ts file only`), and so corrects `uuid`'s, which read
"the call only" while the key rode a flag and a variable.

## §5 Kept fixed

| Parameter | Where | Reason |
|---|---|---|
| `MAGIC` 0xf3, `MAX_FRAME` 256 MiB, `HEADER` 11, `MAX_DEPTH` 64, the varint rules, the 3-byte string fast path, the `VT.int` bound, the crc32c polynomial | kernel/codec.ts | Wire format. A member with a different value drops legal frames. |
| The ring hash (ring.ts `fnv`: fnv-1a, its basis and prime, finished with murmur3's fmix32 and its two multipliers; I-24), the state hash's FNV basis and prime (node.ts `fnv`, a separate plain fnv-1a), `VNODES` 32, the `#` vnode separator, the injectable ring hash and `place()` | kernel/node.ts, kernel/ring.ts | Every member must compute the same ownership: the ring hash is part of the wire contract, and members on different ring hashes are unsupported before 1.0. Test seams by declaration. |
| `incarnation`, `boot`, `durable`, `client`, `name` | kernel/node.ts NodeOpts | Durable protocol state or derived modes. A hand-set value can double-vote or reuse a lane. `name` is the positional argument. |
| The view-majority and R-set quorum thresholds, `cluster.partitions.w` | kernel/confirm.ts:180/183, api/index.ts:447 | The definition of "confirmed". api/types.ts:153 says never configurable. |
| The kernel tune table (2026-10-08): `redials` 10, `memberRedials` 5, `redialGrowth` 2, `redialCap` 32, `suspectTicks` 3, `leaveTicks` 4, `pulls` 5, `proposalAge` 10, `rejoinTicks` 10, `retryTicks` 2, `pending` 1024, `dedupKeep` 1024, `issuers` 1024, `probes` 1024, `queued` 256, `compactAt` 4096, `snapshotAt` 4096, `lamportLease` 4096, `shedTicks` 2, `stageTicks` 8, `acqLiveMax` 8192, `stallAt` 8 | kernel/tune.ts (`Tune`, `TUNE`, `tuneOf`); the old constants (`MAX_REDIALS`, `SUSPECT_TICKS`, `MAX_PENDING` …) are the defaults, by name, where they always were | One frozen object per node (`node.tune`), built first in the Node constructor from `TUNE` plus `NodeOpts.tune`, validated (an unknown row, a fraction, or an integer under the row's floor throws: 0 is allowed only for the two redial counts, every other row starts at 1). Every read site reads a row; the shell weld (`LEAVE_TICKS` in shell/runtime.ts) and the sim monitor read the node's rows. Defaults equal the old constants: the 200-seed trace diff and the 20-seed golden in sim/exec.test.ts are byte-identical. `redial.tries` (→ `redials`) is the one row with a `fero()` key; `memberRedials` is the eviction clock (its own DECISIONS line); the rest are rows without keys until a need is filed. `suspect.ticks` waits for the HELLO contract hash (a cluster contract). `pending` is table-only until measured. |
| `REASON_MAX` 256, `MAX_RUN` 1024, the 2-tick re-offer, the 4096 member bound, `DIAG_MAX` 4096, `DIAG_P` 1, the 1024-record snapshot chunk, the jitter | kernel/write.ts, membership.ts, diag.ts, node.ts | Wire hygiene and protocol identity, NOT tune rows: a member with a different value would drop legal frames or mean something else by a frame. `MAX_RUN` is the longest WACK/WNACK run accepted off the wire — it used to share `MAX_PENDING`'s value and is split off so tuning the queue cannot change what the wire accepts. |
| Write default `'committed'`, write timeout 10 000, call timeout 10 000, gather and remote-read timeout 8000, the 60 s system-probe cap, `liveCadence` ×4 and its 1 s floor, `WRITES_KEEP` 64 | api/index.ts:381-382, 297, 367; api/methods.ts:235; api/fold.ts:124, 249; api/data.ts:63 | Per-call options exist for the timeouts. A global default is a second design with its own duplicate-literal cleanup (two 10 000s, two 8000s, a duplicate 500 at fold.ts:249). `WRITES_KEEP` is read per issued record under api/data.perf.ts. |
| `SIGNALS` list, exit code 0, `METHODS_ONLY`, `SYSTEM`, the `#` prefix, the `~` separator, the `''` root-insert sentinel, the 8-char uuid width, the `127.0.0.1:0` default listen | api/index.ts, api/methods.ts, api/data.ts | Protocol vocabulary and settled contracts. A routable default is never a default (V4-2, V4-3). |
| `DIRECTORY`, `RENDEZVOUS`, `GRACE` 3, `MAX_PER_CALLER` 4096, `RETRY_BASE` 50, `RETRY_CAP` 5000, the jitter, the exponent cap, register timeout 5000, register `retry: true` | api/directory.ts | Box-wide names and host-side policy; DESIGN-DIRECTORY pins them as test seams. |
| `wal.log`, `boot.json`, `.tmp`, `condemned`, the 250 ms leave floor and +2 slack ticks, the mirrored header offsets, `prev: -1` | shell/runtime.ts | On-disk layout and protocol sentinels. A rename orphans every existing dir. |
| `Journal.armed`, the codec scratch sizes and growth factor | kernel/journal.ts:124, kernel/codec.ts:155-159, 452 | Perf-fixture flag and allocation-count constants pinned by alloc.perf.ts. |
| Every sim, tools, tests, examples and utils literal (harness `redialMs` 20 and `journalCap` 65536, PRNG constants, fault ranges, scenario seeds, capture paths `captures/seed-*.json`, shrink budget 2000, `PULL_BUDGET_MS` 1200, the viewer's 1.5 s poll, the examples' 40 s budget) | sim/, tools/, tests/, examples/, utils/ | Tooling, not runtime config (§6). |

## §6 Tooling flags

Only the example role files reach `fero()`; `sim/*` and `tools/debug/serve.ts`
drive the kernel and Runtime directly, so the layer never touches them.

| Script | Flags | Should copts own them? | Prefix if ever |
|---|---|---|---|
| `sim/run.ts` | `--seeds` 1000, `--nodes` 3, `--writes` 40, `--capture`, `--check-every` 1, `--max-events` 1e6, `--no-shrink` | Not now. They are argv flags already, they never reach `fero()`, and prefix isolation is verified (`--seeds` does not leak into the fero subtree). `--nodes`/`--writes` must agree with `shrink.ts` (three copies of 3/40), so a shared prefix would remove a class of "unreproducible" mistakes later. | `fero.sim` |
| `sim/shrink.ts` | `--seed`, `--replay`, `--nodes`, `--writes`; budget 2000 | Same. | `fero.sim` |
| `sim/scale-run.ts` | `--seeds`, `--only`, `--check-every` 1000, `--max-events` 1e7 | Same. Note `--only a --only b` would collect into an array under minimist, which the exact-match filter does not handle. | `fero.sim` |
| `tools/debug/serve.ts` | `--port` 4699, `--live`, `--nodes` 5, `--contend`, `--attach`, a positional capture file, env `FERO_DIAG_TOKEN`; `PULL_BUDGET_MS` 1200; the viewer's 1.5 s poll | A good later candidate: `--port`/`--live`/`--nodes` from env or a file is natural for a dashboard. `FERO_DIAG_TOKEN` stays an env var (never argv: ps-visible). Its own follow-up. | `fero.debug` |
| `tools/debug/scenarios.ts` | `--rebase` | No. A deliberate per-invocation act that rewrites a tracked baseline. | none |
| `tools/perf/absolute.ts` | `--pin`, `--tolerance` 50, `--runner`, `--reason`, `--pinned`, `--force` | No. Every pin must name its box and its reason per invocation; a default from env or a file would defeat the point, and `--force` from a file would silently disable the concurrent-sessions guard. | none |
| `package.json` scripts | `FERO_RENDEZVOUS=off`, `--test-concurrency=1`, `--expose-gc` | Replace the env prefix with `--import ./utils/battery.ts` (step 1). The others are runtime requirements, not knobs. | none |

## §7 Implementation steps (one commit each)

1. **test(utils): `utils/battery.ts`.** Sets `FERO_CONFIG=off` and
   `FERO_RENDEZVOUS ??= 'off'`. First import of the seven `fero()`-calling
   suites; `--import ./utils/battery.ts` in `test`, `perf`, `perf:alloc`.
   The examples tier stays isolated by the inherited env alone (no
   `execArgv`); say so in its banner. Check: `npm test`, `npm run perf`;
   counts unchanged.
2. **feat(api): `api/config.ts`, the one copts seam, no caller yet.**
   `resolveConfig` with injected sources; the fold, the schema check, the
   carriers table, the coercion table, the per-name rung, the memoized files
   resolver, `from`. `api/config.test.ts`: every row of §2 (camelCase from
   env, a stray `FERO_DIAG_TOKEN` stripped, `FERO_HEARTBEAT_MS` throws with
   the hint, both spellings in one layer throw, CSV hosts, `off`/`0`/`false`
   for rendezvous and listen, `FERO_SIGNALS` refused by name, `--seeds` does
   not leak, repeated `--fero.hosts` flattens, `fero.shop.dir` beats
   `fero.dir`, the files walk runs once per `(cwd, home)` by a counting spy,
   `FERO_CONFIG=off` makes zero copts calls). `api/config.perf.ts` advisory
   pin. Check: `npm test`, `npm run perf`.
3. **feat(api): wire the layer into `compose()` for public `fero()`.**
   System composes bypass it. The three numeric shape checks. The source
   appended to existing key messages; the legacy `FERO_RENDEZVOUS='garbage'`
   text preserved. The `rendezvous` env rung through the shared normalizer.
   `diag(f).config()` (the Symbol door, api/diagnostics.ts:55) returns
   `{ key: { value, from } }`. `api/index.test.ts` cases: a stray call key
   still throws; provenance in one message; a `FERO_LISTEN` in the env leaves
   the `#directory` client's listen untouched. Check: `npm test`
   (api/directory.test.ts:149 untouched and green), `npm run perf`.
4. **test: `tests/config.test.ts`, the end-to-end tier.** Child processes
   with a real argv, env, `HOME` and cwd all pointed at scratch dirs, and
   `FERO_CONFIG` DELETED from the child env (else every case runs with the
   layer off and passes vacuously): a project `fero.opt.ts` with `listen:
   '127.0.0.1:<free port>'` shows on `cluster.me.listen`; `--fero.listen`
   beats the file; `FERO_RENDEZVOUS=garbage` gives the legacy error; a stray
   `FERO_HEARTBEAT_MS` throws with the hint; two resources in one process
   with `FERO_SHOP_DIR` and `FERO_USERS_DIR` get different dirs. Plus a guard
   that the repo root holds no `fero.opt.*`. Check: `npm test`.
5. **feat(api): `server: false` pins the client role.** Any server marker
   from any layer then throws naming the marker and its source. Closes
   IDEAS.md:180 (`client: true`). Test in `api/index.test.ts`.
6. **docs: V4-10.** README "Configuration": the precedence line, the §4 table,
   the cluster-contract warning on `heartbeatMs`/`replicas`/`seams.validation`,
   the loud line that a `$HOME` file reaches every fero process of that user on
   the box and must never name a routable listen or rendezvous, and
   "`FERO_DIAG_TOKEN` is the viewer's, not fero config". A drift test that
   every declared key and default appears in the table. `api/types.ts`
   FeroConfig banner (layers and call-only keys). CLAUDE.md: `api/config.ts`
   as the one copts seam in the Layout table, the copt sibling noted next to
   data, `FERO_CONFIG=off` next to the battery note. DECISIONS V4-10:
   precedence (the flag above the code, decided), the coercion and carriers
   tables, why `signals`/`methods`/`seams` are call-only, why `uuid` never
   comes from a file, the sibling-import posture and the publish follow-up,
   `FERO_CONFIG=off`, the per-name rung and its object-key softening.
   STATUS.md: the log line and re-derived counts. IDEAS.md: the seams line
   gets a note (no layer can carry a function, so the layer does not force
   the decision), the `client: true` line closes as `server: false`, a new
   P3 for a HELLO-carried hash of contract keys. The examples' READMEs may
   show `FERO_DIR=./a node server.ts` in their "scale it" lines; role files
   stay untouched (the site inlines 02's files by path: re-record on a quiet
   box if they change).
7. **The tune table — landed 2026-10-08** (see §5's tune-table row): kernel/tune.ts,
   `node.tune`, every read site reading a row, the shell weld and the sim monitor
   gone, `redial.tries` the one config key, `memberRedials` 5 the first live row
   (its own DECISIONS line). Proven byte-identical (the 200-seed trace diff, the
   20-seed golden) and perf-neutral (interleaved A/B on the write, node, alloc
   and data pins). Still to come: `suspect.ticks` after the HELLO contract hash,
   `pending` after it is measured, a live-read cadence if a need is filed. Then
   `diag` (§4). Then publish copts, flip the import, add the `dependencies` entry.

## §8 Risks

- A `$HOME` `fero.opt.ts` reaches every fero process of that user on the box.
  The battery is immune (`FERO_CONFIG=off`); a hand-run example is not
  (`npm run demo` runs with the layer ON). Mitigated by the doc line and by
  unknown-key throws, not by code.
- Cluster-contract drift gets easier: a per-box `FERO_REPLICAS` or
  `FERO_HEARTBEATMS` makes two members disagree with no source line differing.
  The kernel has no detector outside the sim's exactly-R monitor. Documentation
  now; a HELLO-carried hash of contract keys is the real fix and is a wire
  addition, so a separate decision.
- A launch flag beats the code. An operator can flip a process's role from the
  command line (`--fero.dir`, `--fero.server`). Explainable through
  `cluster.me.role` and `diag(f).config()`, but new. A host application that
  embeds fero inside its own CLI exposes `--fero.*` to its users by
  construction; prefix isolation makes that visible, not forbidable, and the
  host's own argv parser must tolerate `--fero.*`.
- Throwing on every unknown `FERO_*` variable is a hard stop for all `fero()`
  calls in that shell. The message names the variable and the nearest key.
  STATUS.md:332 shows `FERO_EXAMPLE_TICKS` once existed on this box; nothing
  reads it today.
- A `dir` in a shared project file: a second process on the same checkout
  opens the same WAL as the same identity. The hazard exists today for a
  code-level dir; the file layer makes it easier to trip. Per-name scoping and
  a doc line.
- Numeric-looking text is mangled by minimist and copts (`--fero.uuid
  12345678` arrives as a number). Refused with advice until copts grows a
  `strings` list (§9).
- The sibling import ties this tree to `../copt` with its `node_modules`
  installed, as it is already tied to `../data`.
- File provenance is coarse ("a fero.opt.ts file"): copts does not say which
  of the project or home file won. Acceptable now; a copts return value can
  carry it later (§9).
- Files load once per process through `require`. Editing `fero.opt.ts` needs a
  restart. This is the one process-level state the layer adds beside V4-8's
  signal listener; DECISIONS should say so.

## §9 Three wishes for copts (none blocks the landing)

1. A declared-keys mode for the prefixed form, with case-insensitive env
   matching, as the no-prefix form already does (`src/index.ts:127`). fero
   could then delete its fold and its unknown-key pre-check.
2. Provenance: return which layer (and which file path) won per key, or
   `files: 'project' | 'home'`, so a file error and the `from` trace can name
   the path.
3. A `strings` list (keys never coerced), so `--fero.uuid 12345678` survives.

## §10 Open questions for the owner (answered in §11)

1. **Precedence.** May a launch flag (`--fero.<key>`) beat the value written in
   the call? copts and the old fero say yes; DECISIONS V4-3 only settled
   key > env > constant. This is the one new rung; it lets an operator flip a
   process's role from the command line.
2. **Unknown `FERO_*` variables.** Throw at `fero()` time naming the variable
   (recommended, consistent with "typos throw"), or ignore silently? Throwing
   is a hard stop for every `fero()` in a shell that carries any unrelated
   `FERO_*` name.
3. **Per-name scoping in this landing?** Recommended yes (§3); it is the first
   thing a two-resource process hits, and it softens "unknown keys throw" for
   object-valued keys in the global layer.
4. **`diag`.** Land it in this series, or after (recommended after, §4)? And
   should `FERO_DIAG_TOKEN` stay the viewer's variable only, or also arm
   `diag.allow` on every server launched from that shell (a security posture
   change driven by ambient env)?
5. **`server: false`** as the client pin now (step 5), or stay deferred? Env
   and files can now add server markers, which is the case IDEAS.md:180 was
   waiting for.
6. **Dependency posture.** Sibling import now and publish later (recommended),
   or publish copts first and depend by version from day one (fero's first npm
   dependency and first install step)?
7. **The tune table.** Approve it as a separate later series, and which
   constants first (`MAX_REDIALS`, `SUSPECT_TICKS`, `LEAVE_TICKS`)?
8. **`engines.node >= 22.18`** in package.json now?
9. **Examples.** May the 01/02 READMEs show `FERO_DIR=./a` and `--fero.dir`
   in their "scale it" lines, given the site inlines 02's files by path?

## Evidence

- copts' README and `src/index.ts` read in full; its 19 tests run green.
- Five scratch experiments against copts with fero's key shapes (§2), plus
  the no-prefix control, the nested-vocabulary control, and `--no-` negation.
- A 26-agent audit over the tree: nine area readers, nine per-area skeptics
  (401 parameter rows confirmed or corrected against `file:line`, 7 refuted
  as vocabulary), a constraints reader over the ledgers (24 settled rules),
  three independent designs (minimal / full constants / operator-first), two
  judges (both picked the minimal design; its best grafts from the others are
  in §3), a synthesis, and a completeness critic whose findings are folded in
  above (the examples tier's env-only isolation, the memo being fero's not
  copts', the `diag(f)` door spelling, `packageDir` skipping silently, the
  per-name gap, the `FERO_DIAG_TOKEN` shorthand collision, both-spellings
  ambiguity, the step-4 vacuity, the `fero.opt.ts` shape).
