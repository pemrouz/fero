# ISSUES — bugs discovered, with evidence

Bugs found while working on the debugger, recorded so they are not lost. Each
entry: where, symptom, root cause with file:line, a suggested fix. Open items
sit first; fixed ones stay at the bottom with the commit that closed them.
Design-level open work still lives in [IDEAS.md](IDEAS.md); settled
decisions in [DECISIONS.md](DECISIONS.md).

## Open

### I-40 · viewer: the omni box says "no matches" for a fragment while the count beside it says 1 match
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html) `renderMenu`
  (~777-803; the phrase at 801); the count in `renderBar` (826-831); a bare
  clause matches row LABELS in `matchNode` (610).
- **Symptom:** type `k4` on 20's capture: the box says `1 match`, the panel
  under it says `COMPLETE "K4" — no matches for "k4"`, and the tree shows the
  one cell `k4`. Cosmetic — the filter works; the two lines contradict.
- **Cause:** the panel's "matches" means completions (filter heads,
  severities, uuids, journal kinds), not rows, and borrows the count's word.
- **Fix idea:** `no completions for "k4" — filtering as text`; or offer
  `key:k4` when the fragment matches a cell or a write label.
- **Status:** open. Found by rung 20 (2026-09-22).

### I-39 · viewer: the debugger gives up on a capture file that is not there yet — 23's live flow needs a reload
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html) `boot()`
  (1362-1376): ONE fetch of `/capture.json`; `startPoll()` only after a good
  `'live'` answer; the `catch` paints "Couldn't load" and returns.
  [tools/debug/serve.ts](tools/debug/serve.ts):131 reads the file on every
  request; a missing file is ENOENT → 500 (136-137).
- **Symptom:** open `npm run debug -- examples/23-live/live.capture.json`
  before `live.ts` has written `capture 1` (or start the debugger first, as
  a reader would): the page paints `Couldn't load /capture.json (HTTP 500)`
  and never asks again. The file lands a second later; a reload fixes it.
  23's README works around it in words ("once `capture 1` is there").
- **Evidence:** probe 2026-09-28 (the real page in Chromium via
  playwright-core, scratch `land/warts-tools/probe-viewer-boot.txt`): 1 fetch
  before and 5 s after the file appeared; 3 after a reload.
- **Fix idea:** in boot's catch (no `?scenario=`) say "waiting for
  /capture.json…" and retry at the poll cadence; or serve.ts answers a
  missing file 404 with a typed body the viewer keys on. A DOM-harness case
  pins it: file absent at boot, present two seconds later, no reload.
- **Status:** open. Found by rung 23.

### I-38 · data: the 3-arg `reduce(add, remove, init)` uses an object `init` AS the accumulator — never cloned, so it is shared, mutated and compounds
- **Where:** ../data [ops/misc.ts](../data/ops/misc.ts) `ReduceIncrementalNode`
  — `seed()` returns `this.init` itself unless it is a function (382-383);
  the constructor folds onto it (376-377) and the mid-batch `recompute`
  re-seeds from the same object (410). The 2-arg `ReduceNode` clones
  (`seedAcc`, 325-326) under a comment that names this very bug (293-296).
- **Symptom:** a fold that changes its accumulator in place (`acc[k] += v;
  return acc`) seeded with `{}`: the caller's object IS the live
  accumulator; two views handed the same init share one accumulator (a
  second view's construction writes into the first); a `value()` read inside
  an open `batch()` re-folds every row onto the full object and the wrong
  total STAYS (`{ north: 12, south: 4 }` for `{ north: 6, south: 2 }`). The
  thunk `() => ({})` and the 2-arg form are right. The signature's comment
  ("init is the fold's identity ELEMENT — a plain value", public.d.ts:319-325)
  invites exactly `{}`.
- **Evidence:** probes 2026-09-28 (scratch `land/warts-data/probe3-reduce.txt`,
  `probe3b-reduce-shared-init.txt`). Found by rung 43, whose `add`/`remove`
  spread-copy and so dodge it — a reader who writes `acc[k] += v` inherits it.
- **Fix:** `structuredClone` a non-null object init in `seed()` as `seedAcc`
  does; or refuse a non-thunk object init on the 3-arg form with the pointer
  `pass a thunk: () => ({})`. A misc.test.ts case: an in-place fold, a shared
  `{}`, a mid-batch read.
- **Status:** open — a data-side fix (../data keeps no ISSUES ledger; its
  STATUS.md is the place to note it).

### I-37 · data: `distinct()` with no function folds every object row into one `'[object Object]'` bucket
- **Where:** ../data [ops/misc.ts](../data/ops/misc.ts) `DistinctNode` —
  `this.fn = fn ?? ((r) => r)` (454) and the bucket key `String(v)` (467,
  511, 544); the shipped type offers the no-function form on any row type
  (public.d.ts:335).
- **Symptom:** on object rows `f.data.distinct()` is ONE bucket keyed
  `'[object Object]'` holding the first row, and it never changes as rows
  arrive. No error, no hint. `distinct((r) => r.cat)` works.
- **Cause:** `String(anObject)` is the same for every plain object; nothing
  checks the projected value's type; the suite's `distinctOracle` mirrors
  the same `String(v)`.
- **Evidence:** probes 2026-09-28 (scratch `land/warts-data/probe1-distinct.txt`;
  `probe4-fero.txt` at the fero lens). Found by rung 05.
- **Fix:** fail fast as `assertBy` does for `za(5)`: `data: distinct() on
  object rows needs a projection — distinct((row) => row.field)`; or key such
  values by a stable serialization. Note `dedupKey: 'distinct'` shares one
  node across every no-function call on a source.
- **Status:** open — a data-side fix.

### I-36 · shell: a member whose WAL dir is deleted under it keeps answering `persisted`, then dies mid-leave on an uncaught ENOENT
- **Where:** [shell/runtime.ts](shell/runtime.ts) `boot` (229-238;
  `fs.openSync(p + '.tmp', 'w')` at 232, no catch), called from
  [kernel/node.ts](kernel/node.ts) `persistBoot` (989) inside `step`. The WAL
  append path has a latch for this class (`#walFailed`, 101-104 →
  `persistFail`); the boot path has none.
- **Symptom:** `rm -rf <dir>` under a running durable member changes nothing
  it can see — the WAL fd is open on the unlinked file, so appends and fsyncs
  succeed and every `confirm: 'persisted'` is acknowledged to a directory
  that no longer exists. The first boot-record write after that — the clean
  leave's vote (`#knockLeave → #propose → persistBoot`) — throws ENOENT out
  of `step`, uncaught: the process dies mid-leave, a crash as the cluster
  sees it (a two-member cluster then wedges, I-20's shape).
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/wal-gone.txt`):
  three `persisted` after the rm, then `UNCAUGHT at destroy: ENOENT …
  boot.json.tmp` at `boot (shell/runtime.ts:232) ← persistBoot
  (kernel/node.ts:989) ← #propose ← #knockLeave`. Rung 30's scale run hit
  it on two members when a second story wiped their dirs.
- **Fix:** catch in `boot()` and latch `#walFailed`, so the store is
  condemned like a failed fsync and `persisted` stops being answered; let
  the leave complete without its record (leave without proposing — the
  survivors evict); optionally `fstatSync(dir)` on each boot write so the
  fault surfaces at the first write after the deletion. A sim `storeFault`
  on the boot sink pins it.
- **Status:** open. Found by rung 30.

### I-35 · config: a `FERO_*` variable that extends a leaf key turns the leaf into an object, drops the good value, and the error blames the good variable
- **Where:** [api/config.ts](api/config.ts) `walk`, the leaf branch (193-197:
  `out.set(path, v)` for any `v`); the composer's checks that then fire
  ([api/index.ts](api/index.ts) 114-115 `dir`, 156-159 `rendezvous`).
- **Symptom:** the env layer splits names on `_`, so `FERO_RENDEZVOUS_UNUSED=1`
  is the nested key `rendezvous.unused`. Beside `FERO_RENDEZVOUS=127.0.0.1:12345`
  the object wins the merge — `rendezvous: { unused: 1 }`, no error — and the
  composer refuses with `FERO_RENDEZVOUS='127.0.0.1:12345' is not a
  'host:port' address (or 'off')`: the one variable that was right.
  `FERO_DIR_OLD=./y` beside `FERO_DIR=./x` dies as `dir must be a non-empty
  path (from FERO_DIR)`. An unknown top-level name and an unknown name under
  a GROUP are refused as the README promises; a longer name under a LEAF is
  not.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/config-env.txt`,
  `resolveConfig` with an injected env); rung 42's builder hit it by hand.
- **Fix:** in `walk`, at a declared leaf, refuse a plain object from the flag,
  env and file layers, naming the longer spelling: `unknown option
  'rendezvous.unused' from FERO_RENDEZVOUS_UNUSED — rendezvous takes a value,
  not a group`; a case in api/config.test.ts.
- **Status:** open.

### I-34 · directory: a cleanly-left server's entry stays until three more link folds at the host — every lookup meanwhile hands out a dead address
- **Where:** [api/directory.ts](api/directory.ts) `hostMethods` — `seen` /
  `grace` (116-118), `register` (133-150), `onPeers` (163-172); the host
  taps its own cluster view for passes (304).
- **Symptom:** the box directory drops a registrant's entries when its link
  goes, keyed off `seen`; a registrant is `seen` only when an `onPeers` pass
  finds its peer row `up`, and passes run only on the host's cluster folds.
  A `register` lands after the fold that published its caller, so with two
  servers and nothing else the second is never `seen`. When it leaves
  cleanly, its link-down fold counts grace 1; two more link events at the
  host are needed before the entry goes. Until then `lookup` answers the
  dead address — every joiner and client dials it — and `cluster.me.hosts`
  keeps it.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/dir-leave2.txt`):
  two servers, b leaves cleanly; `lookup` still returns b's address at
  +300 ms, +1 s, +3 s and +6 s; gone at the third pass. With a third instance
  present from the start (`dir-leave.txt`) it goes within 300 ms — why the
  smoke tier never sees it. Found by rung 21.
- **Fix:** call `onPeers()` at the end of `register` (idempotent,
  `afterFold`-coalesced); pin with a two-server leave in api/directory.test.ts.
- **Status:** open.

### I-33 · api: `cluster.writable` on a client is `true` before it holds a view and `false` for ever after, while its writes commit
- **Where:** [api/index.ts](api/index.ts) 492 and 565 (`writable:
  node.membership.gate(node).open`, on every role);
  [kernel/membership.ts](kernel/membership.ts) `gate` (169-179).
- **Symptom:** the gate answers for a MEMBER: open at epoch 0, then `evicted`
  for any node not in the view. A client is never in the view, so its
  `writable` is `true` while it has no view and `false` once it does, and
  stays false while every write it relays commits. api/types.ts 192-197 gives
  no client rule; a dashboard built on it says the cluster is closed.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/client-view.txt`):
  `client at once: writable true | epoch 0`; `after 2 s: writable false |
  members 3`; `client write while writable=false: committed`. Found by rung
  30, which omits the field for this reason.
- **Fix:** on a client, `writable` should mean "my feeder's view takes
  writes" — true while a primary link is admitted and its view has a quorum
  (the primary says so in a frame, or the client approximates by `primary
  !== null`); at minimum type the client rule in `ClusterShape`.
- **Status:** open.

### I-32 · api: `cluster.me.hosts` is typed as the effective dial targets, but it is the configured set plus the directory's — not what the kernel dials
- **Where:** [api/types.ts](api/types.ts) `ClusterShape.me.hosts` (203: "the
  EFFECTIVE dial targets — static ∪ discovered"); [api/index.ts](api/index.ts)
  `meRow` (487: the `hosts` option ∪ `discovered`).
- **Symptom:** the kernel dials more than the row shows — every member of
  the view it learns, by the address each gossips (kernel/node.ts 388;
  kernel/membership.ts 443-446). A client told one address reads `hosts
  [one]` while `peers` shows three links. After a clean leave the row keeps
  the leaver's address (I-34's half).
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/client-view.txt`):
  `peers (linked) 3 | me.hosts ["127.0.0.1:45891"]`. Rung 15's client screen
  reads right only because it was told all three. Found by rung 15 and phase 1.
- **Fix:** fold the kernel's real target set into the row (the dialed `to`
  of every live link plus the redial table), or reword the typed comment to
  "configured ∪ published by the directory" and point at `peers` for the
  linked set.
- **Status:** open.

### I-31 · api: `cluster.me.origin` says `uuid~1` in a node's first life while every stamp says the bare uuid
- **Where:** [api/index.ts](api/index.ts) `meRow` (485: `origin: node.uuid +
  '~' + node.incarnation`) vs [kernel/node.ts](kernel/node.ts) 257
  (`incarnation > 1 ? uuid~inc : uuid`).
- **Symptom:** the origin is the lane a node stamps its writes under.
  `me.origin` spells life 1 as `uuid~1`; the stamps, `WriteResolve.origin`
  and `cluster.writes[*].origin` spell it as the bare uuid. From life 2 on
  they agree. A screen that joins the two ("which writes are mine?") fails
  in life 1.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-cluster/origin.txt`):
  `life 1 | me.origin efbc64f4~1 | WriteResolve.origin efbc64f4`; `life 2 |
  efbc64f4~2 | efbc64f4~2`. Found by rungs 12 and 13; 13's README says by
  hand which is which.
- **Fix:** `origin: node.origin` in `meRow`, plus a separate `incarnation`
  field for screens that want a life counter. 12, 13, 30 and 43 print
  `life <uuid>~1` and 12 keys rows by it — their READMEs re-record after the
  fix.
- **Status:** open.

### I-30 · api: `methods.update({ key: undefined })` reaches the kernel and kills the process — on a cluster even after the caller catches it
- **Where:** [api/index.ts](api/index.ts) 51-52 (`keyPath(undefined)` →
  `[]`), 431/435 (`update` / `remove` hand it to `write`);
  [api/data.ts](api/data.ts) `Bind.issue` (139-150) checks only
  `seams.validation`; [api/substrate.ts](api/substrate.ts) 93/103 rethrows
  the lane's reject inside the kernel step; ../data/seam/index.ts 346-347
  refuses a whole-source update (key []). `Change.key` is optional
  (api/types.ts:43), so `update({ value })` type-checks.
- **Symptom:** solo: the call rejects with a plain data Error (not a
  WriteReject); uncaught, it kills the process. Two members: the caller
  CATCHES the rejection and keeps running — then the same error is thrown
  again about a second later from the projection branch (`Bind.#onApply`,
  api/data.ts:257), outside any try, and the process dies anyway. The peer
  stayed up.
- **Evidence:** probes 2026-09-28 (scratch `land/warts-api-write/p10-keyundef.out`,
  `p10b.out`, `p10b-A.log`). Found by rung 30's skeptic.
- **Cause:** an empty key is never refused before the kernel stamps the
  record; the projection is the first to object, by throwing inside
  `step()`; `issue()` unwinds mid-commit (data.ts:238) and the kernel
  re-applies the record later through branch 4 (data.ts:257).
- **Fix:** refuse `update` / `remove` with an empty key in `write()` or
  `Bind.issue` as a typed `WriteReject` (`reason: 'invalid-key'`, with the
  `data.k = v` pointer) before any stamp — the 'methods-only' shape; consider
  routing a non-'not live' lane reject in `applyRec` to the outcome ring
  instead of throwing inside a step. Pin both verbs.
- **Status:** open.

### I-29 · methods: a derived view returned to a SUB is never disposed — one operator node per subscription lives for the server's lifetime
- **Where:** [api/methods.ts](api/methods.ts) 162-170 (`entry.live = result`;
  `entry.stop` stops only the record stream), 106 (UNSUB), 198-206
  (reapLink / destroy: the same). Data keeps every operator node in its
  parent's `children` until `dispose()` (../data/kernel/node.ts 70, 157-164)
  and walks them on every commit (../data/kernel/runtime.ts 245, 270).
- **Symptom:** `feed: (who, ctx) => ctx.data.filter(r => r.who === who)`
  mints one filter per subscription. Closing the handle or the client dying
  stops the stream but leaves the filter on the source: after five clients
  each open and close a feed, the root has five `filter` children,
  re-evaluated on every commit — a long-lived server slows with every
  subscription it ever served.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-write/p03-sub.out`):
  `children at start: 0` → `5 ['filter' ×5]` after five open/close. Found by
  rung 09.
- **Fix:** on UNSUB / reapLink / destroy dispose `entry.live` when it is an
  operator view minted for this invocation — never the source (`read`
  returns `ctx.data`) nor a shared proxy (the gather's): mark views created
  inside the handler's ALS run, or compare `unwrap(live)[node]` against the
  source. Pin: the children count returns to 0.
- **Status:** open.

### I-28 · methods: a client's fero() resolves with no admitted link; a held open()+call pair is re-dispatched CALLs first, so "open, then act" never shows the delta
- **Where:** [api/index.ts](api/index.ts) 616-636 (a client's compose returns
  after `rt.start()` and the directory start — it never waits for a link);
  [kernel/node.ts](kernel/node.ts) 541-546 (`rpc` with no primary answers
  `unreachable` locally); [api/methods.ts](api/methods.ts) 280-291 (the
  caller HOLDS it), 310-322 (`onPrimaryChange` replays held CALLs first,
  then SUBs).
- **Symptom:** right after `await fero('bank')` on a client, `peers` is
  empty. `h.open(); await c.methods.deposit(…)` sees the view's first real
  frame ALREADY containing the deposit — 100 → 105 never renders as a
  change. With the link up first, both frames show.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-api-write/p03-sub.out`):
  4/4 runs `peers at fero() resolve 0 | frames [0,105]`; the control with the
  link up 400 ms earlier `[0,120,125]`. Found by rung 09.
- **Fix:** replay held SUBs before held CALLs in `onPrimaryChange` (both ride
  the same link in order) — a two-line reorder; or let a client with known
  hosts wait (bounded) for its first admitted link before `fero()` resolves.
  Pin: open + call at resolve, expect the delta frame.
- **Status:** open.

### I-27 · methods: a handler that returns a live scalar streams nothing on SUB — the handle stays `{}` for good, silently
- **Where:** [api/methods.ts](api/methods.ts) 157-170 (host: any proxy result
  streams through `records`), 257 (caller: the mirror is `proxy({})`,
  object-born); [api/substrate.ts](api/substrate.ts) 126-142
  (`applyStreamRec` swallows every reject but 'not live' at 135); data's
  child-path subscription emits ROOT records with the leaf value and refuses
  a scalar root update on an object source (../data/seam/index.ts:299).
- **Symptom:** `methods: { count: (_, ctx) => ctx.data.count }` — the plan's
  idiom for a live number. The one-shot answers 0, then 7; `.open()` says
  `mode: 'live'` and its snapshot is `{}` — and stays `{}` after the server
  writes 7. No error anywhere.
- **Evidence:** probes 2026-09-28 (scratch `land/warts-api-write/p03-sub.out`,
  `p03b-scalar.out`, `p03c-reject.out`: the mirror refuses `whole-value v2
  update for an object-born source must carry an object`). Found by rung 09.
- **Cause:** a child lens over a scalar IS a proxy (substrate.ts:59), so the
  host streams it as root updates carrying a number; the object-born mirror
  cannot hold one and the reject is swallowed. Sibling of IDEAS "SUB-leg
  handler errors are silent at the client".
- **Fix:** re-mint the mirror as a scalar source when the first root record
  carries a non-object; or wrap a scalar leaf as `{ value }` on the host and
  say so; at minimum surface the reject on the handle.
- **Status:** open.

### I-26 · api: the scoped 'holistic' hint says `(await methods.read()).filter(…)`, but read() resolves to a plain object
- **Where:** [api/index.ts](api/index.ts):351 (the hint), :376 / :383 (`read`
  returns `ctx.data` or the gather's result); [api/methods.ts](api/methods.ts)
  :150 / :193 (a CALL collapses a proxy to its snapshot).
- **Symptom:** on a scoped server (`replicas:` set) `f.data.filter(…)`
  throws a typed ScopedError whose hint says to run the operator on `await
  methods.read()`. That is a plain object with no operators: following the
  hint throws `TypeError: r.filter is not a function`.
- **Evidence:** rung 16's probe; re-probed 2026-09-28 (scratch
  `land/warts-api-write/p02-hint.out`); `Object.values(await
  methods.read()).filter(…)` gives the right rows.
- **Fix:** a true recipe in the hint — `Object.values(await
  methods.read()).filter(…)` (or `await data`, the gather) — one string edit
  plus a test that runs it.
- **Status:** open.

### I-25 · lens: `data.count + 1` writes the handle's debug label into the cell; `data.count++` writes NaN
- **Where:** [api/substrate.ts](api/substrate.ts) `lens` get trap (165: every
  symbol is forwarded to the data handle) and data's handle
  (../data/api/index.ts:525-526: `Symbol.toPrimitive` answers the debug
  label `'[data <op>#<id> .<path>]'`).
- **Symptom:** `f.data.count` is a lens, not the number in it. In arithmetic
  JavaScript asks it for a primitive and gets the label: `f.data.count =
  f.data.count + 1` commits the STRING `'[data source#1 .count]1'`,
  `f.data.count++` commits `NaN`. Both replicate; nothing throws. The series
  reads a cell with `await f.data.count` or `f.snapshot.count`, which work.
- **Evidence:** rung 17 (probe4); re-probed 2026-09-28 (scratch
  `land/warts-api-write/p01-arith.out`).
- **Fix:** answer `Symbol.toPrimitive` (and `valueOf`) in the lens with the
  cell's value — then `count + 1` is 1 and `count++` routes through the set
  trap — or throw a typed error naming the two read spellings. Pin with
  `data.k = data.k + 1` and `data.k++`.
- **Status:** open.

### I-24 · ring: fnv-1a bands a member's 32 vnodes into ~4-5 clusters, so ownership skews up to 5-7x at N=4 — the banner promises ~2x
- **Where:** [kernel/ring.ts](kernel/ring.ts) 24-26 (`VNODES = 32`, "within
  ~2x of fair at small cluster sizes"), 29-33 (`fnv`), 64 (a vnode point is
  `fnv(uuid + '#' + v)`), 106-108 (`ownerOf`).
- **Symptom:** at N=4 one member owns several times its fair share, and a
  run of sequential row keys lands on one owner. Rung 16 saw 4 members × 12
  rows held 9/3/8/4 (fair 6), once 2/10; rung 30 saw a region's facts wait
  for the vote in batches.
- **Evidence:** probes 2026-09-28 (scratch `land/warts-kernel/probe10-ring.out`,
  `probe10b-vnodes.out`): one member's 32 points fall in 5 bands; over 300
  random 4-member sets the worst member is 5.18x fair (7.04x in another
  run), 156/300 sets have a member outside [0.5x, 2x]; `k1..k24` are owned
  in 5 runs where fair gives ~18 — consecutive keys hash P/2^32 of the ring
  apart.
- **Cause:** fnv-1a's last step is `(h ^ c) × P`, so keys differing only in
  their last character land about `k × P` apart: `uuid#0`…`#9` form one
  narrow band; 32 vnodes buy about four spread points.
- **Fix:** finish the hash — an fmix32 (murmur3's finalizer) over the fnv
  output for both vnode points and keys: the same probe then reads worst
  1.81x and 0/300 outside 2x. The ring is a pure function of the view and is
  never persisted, but every node of one cluster must run the same hash (a
  mixed-version cluster would elect two owners per partition), and the sim
  goldens and `place()`-pinned schedules re-derive. Fix the banner with it.
  IDEAS "Carried module debts" carries the hash bake-off via `seams.hash` —
  this is the concrete reason to do it.
- **Status:** open.

### I-23 · membership: a spoke teaches a VIEW — reborn memory-only members adopt a client's stale view and never re-form
- **Where:** [kernel/membership.ts](kernel/membership.ts) `onAdmit` (290-293:
  a CLIENT node ships its view on every admit — no `node.client` guard),
  `onView` (400-415: installs any higher-epoch VIEW from any admitted link —
  no `link.client` guard), `onPull` (417-421: a client answers a PULL with
  its view); [kernel/node.ts](kernel/node.ts) 1415-1433 dispatches the
  membership verbs from client links too. The tick banner (193-194) says "a
  client NODE runs none of the member machinery" — these three paths are
  member machinery it runs.
- **Symptom:** memory-only members all die (kill -9) and come back on their
  own addresses with fresh uuids while a client (a sensor, a dashboard) is
  still up. The client redials a reborn member first and ships its old VIEW
  (epoch e with the dead ids); the reborn member installs it (e > 0), holds a
  view it is not in (`writable false`, gate 'evicted'), and genesis can never
  run again (it needs epoch 0); its peer learns the same view from it. The
  cluster never re-forms. Durable members are immune (their WAL view is the
  truth). The other direction is stale too: once a fresh cluster forms at
  the same epoch NUMBER, the client keeps the dead ids in `cluster.members`
  while `peers` shows the live ones.
- **Evidence:** found by rung 30's mutation (the `dir` removed): `epoch 4 —
  members 3 — writable false — rows 0` on the reborn members, then `stuck:
  members 3`. Probe 2026-09-28 (scratch `land/warts-kernel/probe2-with-client.out`
  vs `probe2-no-client.out`): two memory-only members, one client, kill -9
  both, staggered restart — with the client up both reborn members hold
  `members 2 [2581 2d4f]` (the dead ids) `writable false`; without the client
  they form `epoch 1 — members 2 — writable true`.
- **Cause:** membership frames are accepted from any admitted link, and a
  client node runs the view-on-admit and pull-answer paths. V4-5 made spokes
  VIEWS on the data plane; the control plane was left open.
- **Fix:** mirror V4-5 on the control plane — drop VIEW/PULL/PROPOSE/VOTE/
  JOIN/LEAVE arriving on a `link.client` (journal `frameDrop 'membership
  from client'`) and skip `onAdmit`'s ship and `onPull`'s answer when
  `node.client`; let a client install an EQUAL-epoch view whose members
  differ, so its members row heals. Pin in the sim: two members, one client,
  kill both, reboot them as new uuids one at a time with the client's dial
  landing first.
- **Status:** open.

### I-22 · membership: a one-sided static pair never forms when the hostless listener has the lowest uuid — and nothing alarms
- **Where:** [kernel/membership.ts](kernel/membership.ts) `tick`, the genesis
  test (195-203): a node proposes view 1 only when `hosts.length > 0 &&
  links.length >= hosts.length` AND its uuid sorts lowest among the admitted
  members.
- **Symptom:** under `rendezvous: false`, A = `{ listen }` (no hosts) and B =
  `{ listen, hosts: [A] }`. When A's uuid sorts below B's, no view ever
  forms: both sit at `epoch 0 — members 0 — peers 1 — writable true` for
  good, and nothing says why. Uuids are random, so half of all such pairs
  never form. Data still replicates in the open-genesis mode, but with no
  view there is no single writer, no majority, and `confirm: 'replicated'`
  resolves alone.
- **Evidence:** probe 2026-09-28 (scratch `land/warts-kernel/probe1-static-pair.out`):
  hostless listener `uuid: 'a'`, dialer `'b'` → epoch 0 forever; the same
  pair with the uuids swapped → `epoch 1 members 2`. Found by rung 17
  (race.ts pins `uuid: 'a'` on the dialer to dodge it), again by 22
  (story.ts dials c, b, a so the lowest uuid carries hosts) and 23 (uses the
  directory instead). DECISIONS V4-3 recorded the coin flip for the
  directory path and closed it there; the static path still has it.
- **Fix:** (a) let a hostless listener count its admitted non-client links
  as its formation set — propose when lowest and holding at least one
  admitted member link (V4-3 already accepts a late arrival joining at the
  next epoch); or (b) alarm — a journal row and a `cluster.me` flag after N
  ticks at epoch 0 with admitted member links and no proposal — plus a
  README line under `hosts`: in a static shape every member must list at
  least one other.
- **Status:** open.

### I-20 · membership: a survivor stalled across the leave window turns a clean stop into a crash — permanent at n=2
- **Where:** [kernel/membership.ts](kernel/membership.ts) `tick` (the
  `LEAVE_TICKS` bound → `#finishLeave(node, false)`).
- **Symptom:** in a two-member view, if the SURVIVOR's process is stalled (or
  its frames delayed) for longer than `LEAVE_TICKS × heartbeatMs` (2 s at the
  defaults, 200 ms at heartbeatMs 50) across the other member's Ctrl-C, the
  knock is never answered, the leaver goes with `left` b=0, and the survivor
  then sees a crash it can never evict (`members 2 writable false`, forever).
- **Evidence:** 2026-09-14 sim sweep (scratch `wedge/probes`): 25 of 384
  stall schedules wedge — every one "survivor stalled across the leave"; a
  stalled LEAVER never wedges. The 400-schedule chaos sweep's 84 failures are
  the same shape (a partition or slow frames covering the window), before and
  after the V4-6 shortcut fix.
- **Why it is not fixed here:** for a two-member view the graceful leave is
  the ONLY exit, so giving up on it is giving up forever; a longer bound just
  moves the line. Worth weighing: do not spend a tick while no admitted
  member link exists to knock on; surface `left` b=0 at the api (today it is
  journal-only, so an operator sees nothing); or the n=2 tie-break V4-6
  deferred.
- **Status:** open.

### I-19 · directory: a server booting right after the previous directory host died can reject fero() with `c.methods.lookup is not a function`
- **Where:** [api/directory.ts](api/directory.ts) `Directory.start` (the client
  side of the `#directory` system resource).
- **Symptom:** seen once in eight runs of an A/B harness (2026-09-13, a
  reviewer of the example series): a `server: true` process started about
  300 ms after the process hosting the box directory on the same rendezvous
  port was SIGKILLed had its `fero()` promise reject with
  `TypeError: c.methods.lookup is not a function`.
- **Likely cause:** the directory client's link came up (the new host had just
  bound the port) before the host's method names were discovered, so the
  `lookup` handle did not exist yet when `start` called it — the door opens
  before the method table lands.
- **Suggested fix:** in `Directory.start`, wait for `lookup` to be discovered
  (or dispatch by name through the caller with a retry) instead of calling
  `c.methods.lookup` as a bound property; pin it with a test that SIGKILLs the
  host and boots a new server within a few hundred milliseconds.
- **Status:** open — not reproduced deterministically yet.

### I-1 · model: a restarted node's post-restart writes replay ✗ and split into phantom routes
- **Where:** [tools/debug/model.mjs](tools/debug/model.mjs) `stateAt` (the
  `writeLocal` arm: `applyOne(uuid, e.a)`) and `routes` (the `writeLocal`
  arm: `touch(node.uuid, e.a)`).
- **Symptom:** any capture in which a node WRITES after restarting from its
  durable dir shows `replay ✗ <uuid>: size N vs M` in the header, and every
  such write appears as TWO routes — `uuid#seq` (origin-only, peers
  never-arrived, "record not captured") and `uuid~2#seq` (applied at peers,
  never-arrived at the origin).
- **Root cause:** a reborn node stamps under the lane `uuid~<incarnation>`
  ([kernel/node.ts](kernel/node.ts) `origin` derivation), but its journal's
  `writeLocal` rows carry only the seq — the folds join them to the BARE
  uuid lane, where the new-life entries are not.
- **Evidence:** a 2-node durable sim, one write, `sim.restart('n01')`, one
  more write on n01 → lanes `['n01','n01~2']`,
  `verifyReplay` → `{uuid:'n01', ok:false, reason:'size 1 vs 2'}`, routes
  `n01#4097` (origin at n01, never-arrived at n02) + `n01~2#4097` (applied at
  n02, never-arrived at n01). Reproduced 2026-08-30.
- **Why the registry did not catch it:** the `restore` scenario restarts
  but never writes AFTER the restart, so replay stays ✓ there.
- **Fix:** the capture already carries the origin lane per node (the log
  keys and `incarnation` via `diagNode`); either stamp `writeLocal` with the
  lane (a kernel journal change — `a=seq, b=partition` leaves no slot; a new
  kind or a `c` field), or have the folds resolve a node's CURRENT lane
  (`uuid` for incarnation 1, `uuid~inc` otherwise) from `capture.nodes[i]`
  and join `writeLocal` there. Add a registry scenario that writes after a
  restart so `scenarios.test`'s replay-verifies pin covers it.

### I-2 · attach: torn reads make a healthy node show `replay ✗`
- **Where:** [tools/debug/attach.ts](tools/debug/attach.ts) `pullNode`.
- **Symptom:** on `--attach`, a node that is writing steadily shows
  `replay ✗ <uuid>: size N vs M` (or a value mismatch) on some polls with
  nothing wrong.
- **Root cause:** one pull is several round trips — meta → node → journal
  pages → per-origin logs → state — with no snapshot isolation; a record
  applied between the journal pull and the state pull is in `state` but not
  in the journal the fold replays.
- **Fix:** pull `state` FIRST and then the journal (a journal that runs
  past the state can be cut at the state's `t` by the fold), or have
  `q:'node'` return a `t` high-water the bridge trims the journal to; at
  minimum, the header should say "torn read" rather than `replay ✗` when
  the journal's last `t` is beyond the node's reported journal `n`.

### I-3 · viewer: scoped (replicas) captures paint never-arrived CRIT for non-holders
- **Where:** [tools/debug/model.mjs](tools/debug/model.mjs) `routes` (absent
  row ⇒ `never-arrived`) + [tools/debug/viewer.html](tools/debug/viewer.html)
  `outcomeOf` (`settled ⇒ crit`).
- **Symptom:** on a quiesced scoped sim (e.g. the `sim/scale-run.ts`
  `replicas: 3` captures) nearly every write is red "never-arrived" — 97 of
  100 nodes per write — although non-holders are never meant to receive it
  (the owner fans out to holders only; a stray arrival is `gateDrop`, which
  `routes` ignores).
- **Fix:** carry the holder set per partition in the capture (the ring is a
  pure function of the view — `diagNode` could export `holders(partition)`
  or the viewer could rebuild the ring from `view`), and let `routes` mark
  non-holders `not-a-holder` (quiet) instead of `never-arrived`.

### I-4 · viewer: `diverged ✗` / cell `diverged` are CRIT on live and non-quiesced captures
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html)
  `headerFacts` (`converged === false ⇒ crit` unless shrunk-at-violation)
  and `cellRows` (any value disagreement ⇒ crit; only the missing-cell
  branch checks `quiesced`).
- **Symptom:** a live view mid-propagation, or a sim stopped at a horizon,
  paints the same red as a genuine end-state divergence.
- **Fix:** gate the crit on `quiesced && !live` the way `never-arrived`
  already is (`settled` in `outcomeOf`), and paint warn "differs (in
  flight)" otherwise — the `differs@t` pill already exists for the scrubbed
  case.

### I-5 · viewer: the route timeline says "never arrived" on non-quiesced sims
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html) `inspWrite`
  — `D.live ? 'not yet arrived' : 'never arrived'`.
- **Symptom:** the pill (gated on `settled`) says in-flight while the
  timeline line under it says never arrived, on a sim capture that is
  `not quiesced` or `shrunk · ends @ violation`.
- **Fix:** key the timeline wording on the same `settled` predicate as the
  pill.

### I-6 · viewer: the debugger's own DIAG session renders as a stuck `pre-admit` "unidentified" link
- **Where:** [kernel/diag.ts](kernel/diag.ts) exports `diag: l.state ===
  LS.diag` per link; [tools/debug/viewer.html](tools/debug/viewer.html)
  never reads it (`buildForest` flags `pre-admit` on `!l.admitted`).
- **Symptom:** on `--attach`, every node shows one extra `link#N` row,
  peer "unidentified", with a blue `pre-admit` pill that never clears, and
  `links` reads `2/3` on a healthy 2-server cluster.
- **Fix:** render `diag` links distinctly (an "observer" pill, excluded from
  the admitted/total stat) — the field is already on the wire.

### I-7 · viewer: the modal-hash tie-break pills the wrong side in an even split
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html) `derive` —
  `for (const [h, c] of tally) if (c > best)` with `best = -1`.
- **Symptom:** two nodes disagreeing (or a 2/2 split): the FIRST node's
  hash becomes "modal", so only the OTHER side is pilled `diverged` although
  the situation is symmetric; the status bar calls the first node
  "converged".
- **Fix:** when no strict majority exists, pill every side (or none) and
  say "split" in the header.

### I-8 · dashboard: "no baseline yet — this run becomes the reference" is false on the served page
- **Where:** [tools/debug/scenarios.html](tools/debug/scenarios.html)
  `.basenote`; [tools/debug/serve.ts](tools/debug/serve.ts) `/scenarios.json`
  never writes `results/baseline.json` (only the CLI pins).
- **Symptom:** with no baseline file, `npm run debug` shows the note on
  every re-run, forever.
- **Fix:** word it "no baseline yet — run `npm run scenarios` once to pin
  one" (the ELI5 card already says so; the visible line should too).

### I-9 · viewer: reserved journal kinds appear in the `kind:` suggestions
- **Where:** [tools/debug/viewer.html](tools/debug/viewer.html) `sugValues`
  — `Object.keys(capture.vocab)`.
- **Symptom:** `kind:holdBack` and `kind:catchup` are offered (0 rows,
  never emitted — the kinds are reserved by the append-only vocabulary).
- **Fix:** hide vocab names with zero rows in this capture from the curated
  default list (keep them completable, so an old capture still filters).

### I-10 · cosmetic: both pages and the server banner still say "fero v3"
- **Where:** [tools/debug/scenarios.html](tools/debug/scenarios.html)
  `<title>` and `.brand`, [tools/debug/serve.ts](tools/debug/serve.ts) the
  listen banner; the root has been v4 since 2026-08-16.
- **Addendum (2026-09-28):** three READMEs paste the banner as printed —
  examples/20-inside, 22-time-travel and 23-live (and the site inlines
  them) — so the fix re-records those blocks.

### I-15 · model: a fatal `frameDrop`'s dead link can win a client's primary re-election in the replay
- **Where:** [tools/debug/model.mjs](tools/debug/model.mjs) `topologyAt`
  (`electPrimary` skips only `closing` links; `closing` is set by
  dupLink/selfReject/nameReject).
- **Symptom:** on a CLIENT node, when its primary goes down while another
  link is dead from a fatal `frameDrop` but its `linkDown` echo has not
  landed, the kernel elects the next *live* admitted link (`!l.dead`,
  kernel/node.ts linkDown handler) and the replay elects the dead one —
  `synced` on the real new primary reads false for the one round-trip until
  the echo; `verifyTopology` passes at ∞ (self-healed). Reproduced only with
  a hostile frame (`bytesIn` of garbage + a 60 ms delay fault); the sim's
  chaos vocabulary never produces a `frameDrop` (60 seeds: 0 divergences).
- **Root cause:** `frameDrop` is one kind with a free-text reason; fatal
  (`link.dead = true` + close) and non-fatal drops ('unknown verb',
  'malformed digest', …) are indistinguishable from the journal.
- **Suggested fix:** a typed kill row (or a `c` flag on `frameDrop` marking
  fatal) — append-only vocabulary, so a new kind; then `closing` on it.

### I-16 · model: armed (replicas) and durable nodes mint EMPTY stream lanes with no journal row
- **Where:** kernel/node.ts constructor (boot floors: `streams.for(origin)`),
  kernel/write.ts replay entry and the non-held replay advance,
  kernel/write.ts `streams.for` before the M6 gate (a staged record emits
  nothing); [tools/debug/model.mjs](tools/debug/model.mjs) `topologyAt`
  mints lanes from writeLocal/applyInbound/gateDrop only.
- **Symptom:** at an intermediate step a scoped/durable node's kernel holds
  a zero-valued lane the replay lacks (presence only); at ∞ the guard
  refuses such nodes honestly (`streams size N vs M` — 9/30 nodes in a
  scoped-churn probe) or passes when a later row names the origin.
- **Suggested fix:** journal the silent sites (the non-held replay advance
  changes `applied` with no trace at all), or have `verifyTopology` report
  lane presence as a lower bound for armed captures.

### I-17 · model: `synced` is claimed at the `digestIn` row; the kernel flips it at the END of that step
- **Where:** kernel/node.ts DIGEST handler (`digestIn` emit → suffix ship →
  `aeShip` emit → `link.synced = true`); `topologyAt`'s digestIn arm.
- **Symptom:** when the same step also emits `aeShip`, the row after
  `digestIn` shows synced=true one row early (4 of 5,664 digestIn rows over
  5 chaos seeds). Same-step only; a per-step oracle sees 0 divergences.
- **Suggested fix:** accept and document (done in the fold header), or set
  synced lazily on the next non-aeShip row.

### I-18 · attach: the journal is pulled to HEAD after the node snapshot, so a busy node can be refused as "drift"
- **Where:** [tools/debug/attach.ts](tools/debug/attach.ts) `pullNode`
  (q:'node' first, then the journal cursor to `next === undefined`).
- **Symptom:** rows landing between the two pulls make `topologyAt(∞)`
  disagree with the snapshot → `verifyTopology` refuses (`@ end`) for
  snapshot skew, not drift. Same pre-existing class as I-2 for
  `verifyReplay` (state is pulled last).
- **Suggested fix:** fold for verification only over rows `t < jn` of the
  node snapshot, or label the refusal reason 'snapshot skew'.

## Fixed

- **I-21 (fixed in 717441e)** · shell: a member's clean stop could hang until
  `fero.spawn`'s 5 s SIGKILL. `Runtime.destroy()` destroyed its sockets,
  awaited the WAL flush, and only then closed the listener — which kept
  accepting during the wait — and `#accept` had no `node.destroyed` guard
  (unlike `#dial`'s late 'connect'). A peer's redial (30 ms in a hurried
  cluster) accepted in that window was never torn down, so `server.close()`
  waited on it for good; `stop()` resolved null and 30's story threw `a
  member did not stop cleanly`. Load-dependent: 4 hangs in 13 runs of 30's
  check on a busy box, none quiet; 13 shares the exposure. Seen once by the
  30 builder, pinned by the 30 final skeptic (`server.close called — open
  connections 2`, never done). Now the listener closes right after
  `node.destroy()` and `#accept` refuses a socket that lands later;
  tests/tcp.test.ts pins it (a fat WAL append opens the window, a dial lands
  mid-stop, the stop must settle — the old code answers `hung`).
- **I-11 (fixed in e81ac65)** · the stream inspector's Facts rendered
  `seen (high-water) undefined` — `inspStream` destructured a `seen` field
  the entity never carried. Now shows the watermark ladder it does carry.
- **I-12 (fixed in e81ac65)** · the lost-ack card drew its severed link as
  a ≋ dup/delay fault; the scenario installs no fault personality — it
  `severOnFrame`s the WACK once (a one-shot ✂ cut that heals).
- **I-13 (fixed in e81ac65)** · the `frameDrop` journal line read
  `frame error · <reason> — link dropped` for every drop; only wire faults
  and before-hello violations drop the link — an unknown verb keeps it.
- **I-14 (fixed in 2bac581)** · viewer: links/streams never changed under
  time travel and the tree never said so. The 100-node scenario scrubbed
  keys@t/jrnl@t while every node painted 99/99 links and 65 streams at t=0:
  the tree/inspector read the END snapshot (diagNode's tables carry no t),
  `stateAt` folded only writeLocal/applyInbound, and the only statement of
  it was the inspector banner — hidden with nothing selected; the scrubber's
  own ELI5 ("rebuild what each knew then") over-promised. Now `topologyAt`
  replays the link lifecycle and watermark ladder behind `verifyTopology`
  (the fold at ∞ must reproduce the captured end tables — all 20 registry
  captures, every node), and a node that fails the proof keeps its end
  tables labelled `@ end` with the reason on every surface. The review's
  per-step oracle also caught `walTaint` (condemn wipes streams/state —
  both replay planes honour it now, the ∞ refold could not see it).
- **I-1 addendum (2bac581)** · the reborn durable writer is now the
  debugger's truthful *refusal* fixture too: its post-restart writes stamp
  under `uuid~2`, so `verifyTopology` refuses it (`streams size 2 vs 3`)
  and the viewer shows its end tables `@ end` — and `routes` no longer mints
  `''` for a partition no writeLocal row named (null → rendered as absence).

### F · membership: `leave()` answered "nothing to leave" while a peer held the leaver in a two-member view (fixed e8cd830)
- **Where:** [kernel/membership.ts](kernel/membership.ts) `leave` — the
  `view.epoch === 0` / `rejoining()` / `epochStale` shortcuts.
- **Symptom:** about one clean stop in five under CPU load (two reviewers of
  the example series, independently): Ctrl-C on one of two copies exited 0 in
  ~1 ms, the survivor sat at `members 2 writable false` for good, and a third
  copy was never admitted. Nothing in the leaver's journal: the shortcut
  emitted no `leave`/`left` row, so it looked like a crash.
- **Root cause:** the leaver had GRANTED the genesis ballot but not yet
  installed the VIEW frame (in flight, unread under load — or dropped: one
  dropped VIEW frame leaves a node at epoch 0 indefinitely, since PING/DIGEST
  carry no epoch), while the survivor had installed the two-member view. The
  shortcut treated local ignorance as proof about other nodes.
- **Evidence:** real-socket journals (`aa`: propose → viewInstall a=1 b=2 →
  linkDown → gateClose minority; `bb`: vote a=1 … then nothing); 80
  iterations under a 12-thread busy load: 6 wedges, all in the sub-10 ms
  window; a deterministic sim repro (three shapes) now in sim/membership.test.ts.
- **Fix:** "nothing to leave" needs evidence (DECISIONS V4-6, amended
  2026-09-14): knock while no view has reached me and any admitted non-client
  link exists; latch the at-once answer; never grant a ballot that votes an
  answered leaver back in. 80/80 clean after.
