# fero — status

One page. Where fero stands, what is broken, what is worth doing, and what has been decided. The detail behind any line is in [docs/](docs) or in git history. Last updated 2026-09-28.

## Where it stands

- fero v4 is the repo root: branch `v4`, package `fero` 4.0.0. The old v2 surface and the frozen v3 tree are on the `master` branch.
- `npm test`: 495 tests plus the 18-clause `data` contract. `npm run perf`: 43 pins. All green on 2026-09-28.
- The example series is complete: 26 rungs, 01 to 43 ([examples/README.md](examples/README.md)).
- On 2026-09-28 the ledgers were folded into this page and 42 small bugs and warts were fixed in one pass (V4-13 below). What is left here is what still needs a decision or real work.
- The website (`~/fero-site`, outside this repo) shows rung 02 only and does not link the example index yet.
- No git remote, so no CI. The perf baseline is advisory on this WSL2 box; a pinned baseline needs a quiet runner.

## Bugs

What happens, where, and the fix if one is known. The evidence behind each line (probes, file:line, transcripts) is in the old ledgers, `git show 0055e6e:ISSUES.md` and `git show 0055e6e:IDEAS.md`, or in the commit the line names.

### Kernel

- **The ring is skewed.** fnv-1a bands a member's 32 vnodes into 4-5 clumps, so at four members one member can own 5-7× its fair share, and a run of sequential row keys lands on one owner. The banner in `kernel/ring.ts` promises about 2×. Fix: finish the hash with murmur3's fmix32 (the probe then reads 1.8× worst, none outside 2×). Every member must run the same hash, and the sim goldens re-derive with it.
- **A survivor stalled across the leave window turns a clean stop into a crash.** When one of two members presses Ctrl-C, it asks the other to vote it out and waits about four heartbeats for the answer. If the other member is stalled for longer than that, the leaver gives up and goes anyway, and the survivor sees a crash it can never vote out. With two members that is permanent. 25 of 384 stall schedules in the sim. No cheap fix, because at two members the vote is the only exit. Options: wait only while there is a member to ask; show a failed leave at the api (today it is a journal row only); the two-member tie-break V4-6 set aside.
- **A client whose view number is higher than the re-formed cluster's keeps its stale members row.** A client now adopts a view with the same number but different members (I-23, commit 348dfa5). Adopting a lower number would break the rule that a node's view number never goes down, and change what `cluster.epoch` means on a client. Needs a decision.

### The api

- **`cluster.writable` on a client is wrong.** It reads the member gate, so it is `true` before the client holds a view and `false` for ever after, while every write it relays commits. A client needs its own rule: "my feeder's view takes writes", or at least a typed statement that the field is a member's.
- **A method that returns a live number streams nothing on subscribe.** `count: (_, ctx) => ctx.data.count` answers a one-shot call fine, but `.open()` stays `{}` for good with no error: the client's mirror is built to hold an object, cannot hold a number, and the refusal is swallowed. Build the mirror from the first record's type, or wrap the number as `{ value }` and say so.
- **A handler error on the subscribe leg is silent at the client.** A thrown handler, or a refused write inside it, leaves the live handle `{}` for ever and the re-subscribe on failover runs into the same failure. The call leg is loud already. Surface it on the handle.
- **A whole-row write and a field write on the same row are two cells.** Each keeps its own last writer, so the object a node shows can depend on the order the two arrived, and differ between nodes. Reproduced with a seeded row plus a client's field write across a memory-only restart. The examples avoid it: one write style per row. A parent write should win over older child cells, or the projection should apply by key depth. Needs a sim check on the projected object, not only on the cells.
- **A clean stop before the listen socket is up hangs `Runtime.start()`.** The composer now races the start against an early Ctrl-C (commit e3d0b34), but the shell's own start promise never settles if its server is closed before `'listening'` fires.

### Directory, config, shell

- **A server booting right after the directory host died can fail with `c.methods.lookup is not a function`.** Seen once in eight runs: the lookup handle did not exist yet when the directory client called it. Not reproduced deterministically. Wait for the method to be discovered, or dispatch by name with a retry.
- **A store that failed mid-life is not sound to restore from.** After a boot record fails (a `dir` deleted under a running member), the store is condemned and the process lives on, but its later votes and Lamport ceiling are memory-only. The existing policy already condemns such a dir on restart; this line just says so.

### data (the sibling repo, `../data`)

- **`reduce(add, remove, init)` uses an object `init` as the accumulator** and never clones it: two views share one accumulator, and a read inside a batch re-folds onto the full object, so totals compound. Pass a thunk, `() => ({})`, until it is fixed there.
- **`distinct()` with no function folds every object row into one `[object Object]` bucket**, with no error. Pass a projection, `distinct((r) => r.field)`.

### The debugger

- **Scoped captures paint `never-arrived` in red for every non-holder.** With `replicas` set, non-holders are never meant to receive the record. The fold needs the holder set per partition (the ring is a pure function of the view, so a capture could carry it).
- **Known limits of the replay**, accepted and written in the fold header of `tools/debug/model.mjs`. A link killed by a fatal frame drop can win a client's primary re-election in the replay for one round trip. Scoped and durable nodes open empty stream lanes with no journal row, so a reborn durable writer's links and streams show `@ end` instead of replaying. `synced` flips one row early when the same step also ships a catch-up.
- **A truncated journal switches the scrubber off in silence** and paints `replay ✗` in red on a healthy cluster whose ring only did what it was sized to do. A visible word at each site, and warn rather than crit when the only reason is dropped rows.

## Worth doing

### Next

- **A crashed member is evicted only after the redial chain gives up**: about 20 s at the defaults. Its rows freeze on every screen meanwhile. The knob is a shorter chain for members that were reachable a moment ago; it belongs to the tune table.
- **The kernel tune table.** MAX_REDIALS, SUSPECT_TICKS, LEAVE_TICKS, the backoff cap and the queue bounds are constants. One frozen `tune` object built in the Node constructor, defaults equal to today's constants so the sweep bytes stay identical, hot sites reading a field. Land only with an A/B on the write, node and alloc perf pins. Design: [docs/DESIGN-CONFIG.md](docs/DESIGN-CONFIG.md) §7 step 7.
- **`cluster.writes` out of the cluster tap's domain, and on time.** The confirm ring lives in the same view as `members`, so a bare `cluster.tap` fires on every write outcome, and it lags the value by one kernel step (a screen reads `pending` above an object that already holds the row, for up to `heartbeat.ms`). Publish the ring from a microtask on every outcome and give it its own proxy behind the `cluster.writes` getter.
- **A client can knock out a member's link by claiming its uuid.** A client's hello that presents a member's uuid trips the duplicate-link rule against the real member. The write-plane holes around it are closed (V4-4, V4-5) and a spoke can no longer teach a view (I-23); what is left is peer authentication proper, post-1.0.
- **A pinned quiet runner and a git remote.** No remote means no CI; the perf baseline machinery is ready for a pinned box. Then the real v2-vs-v4 socket A/B, with p99s.
- **Every admit ships each missing suffix twice.** Both ends send an r=1 digest on admit, so a join costs twice its bytes. Let the lower uuid open the exchange, or remember the tail shipped per link. A sim golden and the AE perf pin move with it.
- **A HELLO-carried hash of the cluster-contract keys** (`heartbeat.ms`, `replicas`, `seams.validation`). One member's shell can set them alone since V4-10; a mismatch shows as behaviour, not as a refusal at the door.

### Someday

Each of these is one plain line here; the long form is in `git show 0055e6e:IDEAS.md`.

- **api.** `seams: { validation }` could become a top-level `validation:` (the nest has had one member since V4-5); keep the old spelling as an alias for one release. A `diag` config key, so `npm run debug -- --attach` can reach a real `fero()` cluster (`FERO_DIAG_TOKEN` stays the viewer's variable; tokens redacted from `diag(f).config()`). Tell a client in the hello that the resource is methods-only, so its plain write fails at once instead of after a round trip. Decide whether a kernel outcome inside a handler (`superseded`, `dropped`) should fail the call. A `journal.cap` smaller than one step's burst starves the cluster fold: read the dropped count, or floor the cap. A leaving member paints its own leave view as its last frame. `isolate` / `heal` on the diagnostics handle (a TCP shell cannot hold a partition honestly; the sketch is in docs/DESIGN-M7.md).
- **Kernel.** Suspicion watches link liveness, not ping round trips, so a hung-but-connected process looks alive. When the pending-write queue overflows, the oldest write is dropped and counted; how big the queue should be against the retry horizon has never been measured. A lying disk that lies only about the newest row of a lane escapes the hole detector; chained durable marks would close it. Anti-entropy digests go full mesh every tick, O(n²) frames; pair a fix with announcement-gated anti-entropy. A full-mesh pause burst can drop a whole link queue at once.
- **Scoped replication (the M6 leftovers).** Gating anti-entropy on announced possession and un-pinning compaction are coupled: design them together or not at all. Tombstone GC stays pinned while scoped. Distributed `sum` / `max` / `avg` instead of the materialize-first throw. Spokes subscribe to what they watch, not the whole shard. Explicit-undefined cells across the gather. A push-based claim stream. Chunked transfer for oversized partitions. Smaller HAVEQ bodies. The unscoped two-teacher race. Shed only on durable marks. Disjoint partial sums. Nicer remote handles.
- **Directory.** Cross-box discovery: `hosts: ['10.0.0.5']` meaning "ask that box's directory" (needs the explicit-listen rule). A `#` badge for system resources in the viewer. A failure detector over client links, so a hung watcher's entry does not live for ever. Unref the directory client's timers, or document `destroy()` as the exit protocol. One directory client per process instead of one per instance.
- **Sim and scale.** Monitor passes walk every lane even when nothing changed (about 15 ms per pass at n=100); scope the walk to the node that stepped. Scale goldens are tied to (n, writes, seed); failure captures at n=100 are triage-grade only.
- **Debugger.** Ship journal deltas over the DIAG wire instead of whole journals. Cache immutable log entries between rebuilds (never below the node's base). A paged state read with a torn-snapshot marker for a state map over one frame. A newcomer's first gate row says `evicted` though it was never in (say `joining`). A clean leave has two spellings in the survivor's diary. `topologyAt` still joins a reborn writer's rows to the bare lane on purpose: it is the one truthful producer of a replay refusal three suites rely on.
- **Examples.** A live-picture role that also takes typed lines wipes the half-typed line on every redraw (40's join, 41's edit); `rl.prompt(true)` prints nothing without an output stream, and a real prompt line means raw mode. A `sell` rung for the website's narrative. The website links the series index.
- **data (the sibling).** Streaming a windowed sort needs the mirror keyed by position. Apply inbound records per frame instead of per record. Slim `fold.ts`'s cell-isolation armor.
- **Config.** optcascade wishes: a declared-keys mode for the prefixed form, per-key provenance with the file path, a `strings` list so `--fero.uuid 12345678` survives.
- **Open questions.** Cross-partition ordering beyond the recipe (transactions?). AsyncIterator methods.

## Decided

One line each. The full record, with the context and the rejected options, is [docs/DECISIONS.md](docs/DECISIONS.md); the v3 decisions (V3-1 to V3-21) and the carried v2 rejections are there too.

- **V4-1** fero v4 runs on data v4. fero owns the write surface: the lens traps a write before data sees it.
- **V4-2** Role by declared act: a bare `fero(name)` is a client; any server marker makes a server. `f.snapshot` is the sync read. A node's identity comes back from its `dir`.
- **V4-3** Discovery is the per-box `#directory` at `127.0.0.1:3376`. A server binds a free port and registers; `#` names are reserved.
- **V4-4** The relay validates: `seams.validation` runs on a client's relayed write too, and a refusal is a terminal reject with the reason.
- **V4-5** `methods:` is the one spelling for hosted methods and the door. Spokes are views: they never teach a server.
- **V4-6** A clean `destroy()` leaves by ballot, so two members survive a clean stop. Amended: "nothing to leave" needs evidence.
- **V4-7** No ghost: a write shows when it commits, never before. The optimistic copy is gone.
- **V4-8** Ctrl-C is a clean stop, built in. The cluster view folds in one batch. The examples carry no plumbing.
- **V4-9** `fero.spawn` is public. A check meets the box directory. A stop untracks when it settles.
- **V4-10** One config door: `--fero.<key>` > the call > `FERO_<KEY>` > `fero.opt.ts` > the default. Nested lowercase keys. `optcascade` is the one dependency.
- **V4-11** A README is the terminals; a screen is one line or one frame.
- **V4-12** The example series is complete: a story file is a driver, an app may run past ten lines, a check runs every file its README names, no slow tier.
- **V4-13** One ledger. This page holds the status, the bugs, the ideas and the decisions index; the full records live in `docs/`; 42 obvious warts were fixed instead of filed, and the fixes that touched the public surface are listed there.

## History

[docs/HISTORY.md](docs/HISTORY.md): the v4 status log, day by day, and the v3 milestone record (M0 to M8) from the old README.
