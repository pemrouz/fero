# utils — shared test & perf fixtures (`#utils`)

The helpers the test and perf suites would otherwise copy-paste into every file:
free ports, the median-of-5 perf clock, async polling, peer-connected predicates,
and a one-record applier. Reached only through the `#utils` Node import map
([package.json](../package.json) `"imports"` → [index.ts](index.ts)), so a
`foo.test.ts` writes `import { ports, until, bench, apply } from '#utils'` with no
`../../` juggling. This is a **test/perf-only** surface — no library runtime module
imports it.

## Files

| File | Role |
|---|---|
| [index.ts](index.ts) | The whole module: `ports`, `bench`, `sleep`, `until`, `connected`, `apply`. |
| [index.test.ts](index.test.ts) | Pins the fixtures' own contract — `bench.median` copy-not-mutate + upper-middle pick, `bench.time` warmup+5, `until` true-on-pass / false-on-deadline, `ports.free()` bindable. |

## Public surface

```js
import { ports, bench, sleep, until, connected, apply } from '#utils'

const port = await ports.free()          // an OS-confirmed-free TCP port
const ms   = bench.time(() => work())    // one warmup + median of 5 timed runs
await sleep(50)                          // awaitable setTimeout
assert.ok(await until(() => done))       // poll until true (false on timeout)
connected(mesh, '127.0.0.1:3000')        // is addr a connected peer on .peers?
apply(res, { type: 'update', key: ['k'], value: v })  // fold one record into a data res
```

| Export | Signature | What it does |
|---|---|---|
| `ports.free` | `() => Promise<number>` | A port the OS just confirmed free (`listen(0)` → read back → close). A now-snapshot, not a reservation. |
| `bench.time` | `(fn) => number` | One untimed warmup, then the **median of five** timed runs. The canonical perf primitive. |
| `bench.median` | `(xs) => number` | Upper-middle of a sorted **copy** (`length >> 1`). |
| `sleep` | `(ms) => Promise<void>` | A `setTimeout` you can `await`. |
| `until` | `(check, ms = 2000) => Promise<boolean>` | Poll `check` every 5ms; `true` on pass, `false` on timeout. |
| `connected` | `(mesh, addr) => boolean` | Is `addr` a `connected` peer on `mesh.peers`? Works for the L0 mesh **and** the L2 cluster. |
| `apply` | `(res, record) => void` | Fold one change record into a `data` res. Mirrors L1's `applyRecord`. |

## How it works

**The naming convention is the structure.** Related operations group under a
lowercase **noun** whose method names the **action** — `ports.free()`,
`bench.time()`, `bench.median()`; genuinely one-off predicates and actions stay
**flat** — `until()`, `sleep()`, `connected()`, `apply()`. The noun reads as the
thing you want, the verb as what to do with it; `ports.free()` over a
`freePort`/`free_port` free function ([index.ts](index.ts):5-10, and the rule in
[../CLAUDE.md](../CLAUDE.md)).

**`ports.free` is a now-snapshot, not a reservation** ([index.ts](index.ts):22-29).
It `listen(0)` to let the OS pick a port, reads it back, then **closes** and
resolves the number — so the port is provably free *at resolve time*, which is
exactly what a fresh test listener wants (a reservation would be wrong; the test
binds it itself). There's an inherent TOCTOU window, fine for the serial-by-default
functional suite.

**`bench` is the perf invariant.** `bench.time(fn)` runs `fn` once untimed (JIT +
caches) then takes `bench.median` of five `performance.now()`-bracketed runs —
robust to a single scheduling spike ([index.ts](index.ts):37-47). Because every
`*.perf.ts` measures through this one function, all thresholds are comparable, and
[../CLAUDE.md](../CLAUDE.md)'s hard rule applies uniformly: assert
`ok(elapsed < threshold)`, and **never widen a threshold to pass — investigate the
regression.** `bench.median` sorts a **copy** (`xs.slice()`) so it never reorders
the caller's array, and picks the upper-middle element with `xs.length >> 1`.

**`until` returns a boolean on purpose** ([index.ts](index.ts):57-64). It polls
every 5ms and resolves `false` at the deadline rather than throwing or hanging — the
contract is `assert.ok(await until(...))`, so a missed condition fails the test
*loudly* instead of wedging the runner. The single most useful property for the
async cluster-convergence tests.

**`connected` spans two layers with one helper** ([index.ts](index.ts):68-69). It
reads `mesh.peers[addr]?.status?.[value]` and compares to `STATUS.connected` (the
numeric enum from [../transport/peer.ts](../transport/peer.ts):32-37, where
`connected === 3`). Both the L0 mesh and the L2 cluster expose `.peers` as a
ViewProxy, so the same predicate works against either.

**`apply` is the receive-path contract** ([index.ts](index.ts):74-78): dispatch on
`record.type` to `res.update(value, key)` / `res.insert(value, key, at)` /
`res.remove(key)` — the same terminal write contract the day-0 spike proved (plan
§10). Apply a whole frame by iterating `frame.records()` and calling it per record.
Note this body is **identical** to `applyRecord` in
[../log/index.ts](../log/index.ts):29-33 — see Design notes.

## Design notes

- **`apply` ≡ `applyRecord`.** [index.ts](index.ts):74-78 and
  [../log/index.ts](../log/index.ts):29-33 are byte-identical — the record-apply
  invariant lives in two places across the test-helper / library boundary. The
  trade-off is real: collapsing them to one definition (re-export from L1) makes the
  fixture provably the same code replicas run, but drags the whole L1 import graph
  into a test helper; keeping them separate keeps `#utils` light but risks silent
  drift that would hide the exact bug a test exists to catch. `#utils` is already not
  strictly dependency-light — it imports `STATUS` and `ChangeRecord` from
  [../transport](../transport/) — so the lean-ness argument is weaker than it looks.
- **`STATUS` is positional/numeric**, so `connected` keys off the integer `3`; a
  string-enum refactor is parked in [../IDEAS.md](../IDEAS.md) (Wire-format
  micro-optimizations).

## Open work

- **`apply`/`applyRecord` de-duplication** — the contract's home is L1's
  [`applyRecord`](../log/index.ts); the safe fix is for this module's `apply` to
  re-export it (`export { applyRecord as apply } from '../log/index.ts'`) so the
  fixture is provably the same code replicas run (cycle-safe — no library module
  imports `#utils`).
- The broader perf-and-fixtures discipline lives in [../CLAUDE.md](../CLAUDE.md)
  ("Performance is a hard requirement", "Conventions inherited from data"); open
  workstreams across the layers are in [../IDEAS.md](../IDEAS.md).