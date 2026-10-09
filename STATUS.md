# fero — status

One page. Where fero stands, what is broken, what is worth doing, and what has been decided. The detail behind any line is in [docs/](docs) or in git history. Last updated 2026-10-09 (wave 3).

## Where it stands

- fero v4 is the repo root: branch `v4`, package `fero` 4.0.0. The old v2 surface and the frozen v3 tree are on the `master` branch.
- `npm test`: 600 tests plus the 18-clause `data` contract. `npm run perf`: 46 pins. All green on 2026-10-09.
- The example series is complete: 27 rungs, 01 to 44 ([examples/README.md](examples/README.md)); 44 is the website's story, an open shop and then the same shop with a door. The two roles that read typed lines (40's join, 41's edit) are checked on a real terminal by `tests/examples-tty.test.ts`.
- On 2026-09-28 the ledgers were folded into this page and 42 small bugs and warts were fixed in one pass (V4-13 below). What is left here is what still needs a decision or real work.
- On 2026-10-08 the first wave of the STATUS work plan landed (V4-14 to V4-17): the ring spreads, a join ships each missing row once, the method plane's four holes, the shell's early-stop hang and the condemned store, and two `data` fixes. Each lane was built in its own worktree and reviewed by a second model before the merge.
- Later on 2026-10-08 the second wave landed (V4-19 to V4-25): the kernel tune table and a four-second eviction, a client's `writable` and `cluster.writes` done right, the debugger's scoped and truncated captures, the 44-sell rung and the half-typed line, and a double vote latent since M2 closed. The I-20 fix is parked ([docs/DESIGN-LEAVE.md](docs/DESIGN-LEAVE.md)). Overlapping cells (V4-18) landed last, after four review rounds.
- On 2026-10-09 wave 3 landed (V4-26 to V4-29): `validation:` as a top-level key, the `diag` key and the `#` badge, cross-box discovery with the explicit-listen rule, a typed `sparse-hole` reject and the redial-chain fix, and the CI file (unpushed). The door — the contract hash, the methods-only hint and peer auth as one HELLO change — is designed in [docs/DESIGN-DOOR.md](docs/DESIGN-DOOR.md) and waits for the owner's answers before it is built.
- The website lives in [site/](site): one page that runs fero's real kernel and simulator in the tab. The root `index.html` sends GitHub Pages there, the same way `data` does it.
- The remote is github.com/pemrouz/fero, branch `main`. Its `master` is still the 2017 fero 1.x code. No CI yet. The perf baseline is advisory on this WSL2 box; a pinned baseline needs a quiet runner.

## Bugs

What happens, where, and the fix if one is known. The evidence behind each line (probes, file:line, transcripts) is in the old ledgers, `git show 0055e6e:ISSUES.md` and `git show 0055e6e:IDEAS.md`, or in the commit the line names.

### Kernel

- **A survivor stalled across the leave window turns a clean stop into a crash.** When one of two members presses Ctrl-C, it asks the other to vote it out and waits about four heartbeats for the answer. If the other member is stalled for longer than that, the leaver gives up and goes anyway, and the survivor sees a crash it can never vote out. With two members that is permanent. 25 of 384 stall schedules in the sim; `sim/leave-sweep.test.ts` pins the exact seeds today's kernel wedges on (36 of 100 stall schedules, 13 of 100 cut-and-restart schedules), all safe, none live. A fix was built on 2026-10-08 (the leaver's vote carried in the LEAVE, then a pledge protocol) and parked after three review rounds each found a new safety hole; the schedules, the holes, the salvage and the options for two-member crashes are in [docs/DESIGN-LEAVE.md](docs/DESIGN-LEAVE.md). Design first, then code; the branch is `w1/membership`.
- **A ballot built on an older view still commits after the proposer and a voter have installed a newer one.** `#proposal.old` is fixed when the ballot opens, `install()` keeps a proposal whose epoch is above the new view, and a voter grants any epoch above its own view because the PROPOSE frame carries no base epoch. In the double-vote mesh scenario, after bb's and cc's VIEW@2 land, aa's `{aa,cc}@3` built on view 1 still commits with 2 of view 2's 4 members and drops ee, a member its old set never held. It settles to one view and never breaks one-view-per-epoch; found 2026-10-08 in the I-20 salvage review. Belongs in the per-vote-source safety argument [docs/DESIGN-LEAVE.md](docs/DESIGN-LEAVE.md) §9 asks for.

### The api

- **On a scoped cluster, `methods.update` from a node that does not hold the partition never resolves `committed`.** It times out, though the owner commits the write. Probe on the untouched tree: two members, `replicas: 1`; six `methods.update` calls from `aa` gave one `ok` and five timeouts: only the partition `aa` holds resolved. A plain assignment lands; only the await hangs. The likely cause: the issuer's promise waits for its own commit to come back through the apply join, and a non-holder never receives it.
- **An array-valued row's screen can still depend on arrival order.** V4-18 folds object, number, null and string rows the same everywhere. data, though, writes into arrays like objects: an index write replaces the element, a field inside an element lands, and a non-index key becomes a hidden property; and data refuses to remove an array's own key, so the kernel makes no repair inside an array. Write the spliced array. Removing an array's own element is refused before it commits, for the shape this node shows when the remove is issued: the lens throws for `delete data.g[0]`, and `methods.remove({ key: ['g', 0] })` or a client's relayed remove rejects `sparse-hole` (V4-28). Two gaps still commit a tombstone that shows nothing: a scoped node that does not hold the row forwards such a remove to the owner, who does not re-check forwarded writes; and a remove sent in the same batch as a still-pending write that turns the row into an array is judged on the old shape.
- **A relay perf pin is missing.** No pin covers a client's writes relayed through a server, so the relay check every open server now runs (about 7.5 ns per relayed update against about 110 µs per relayed record, measured 2026-10-09) has no number. Add one client, N relayed updates, to tests/baseline.perf.ts.
- **A handler that makes a view and returns a plain value leaks that view (the I-29 residue).** Each such call leaves one dead filter on the source, and data works it out again on every commit. It cannot be released safely today: a view the handler dropped looks the same as one it keeps for its next call (`cached ??= ctx.data.filter(…)`). Releasing it froze the cached view silently, so that change was backed out (V4-16). A fix needs to know when the handler's handle becomes unreachable (a FinalizationRegistry over the handles minted inside a handler). The proxy-return path has a cousin: a view a handler caches on its first call and returns there is released after that call.

### Directory, config, shell

- **A server booting right after the directory host died once failed with `c.methods.lookup is not a function`.** Not reproduced in 30 runs, nor in the new race test (api/directory.test.ts: the host SIGKILLed, a new server 0-500 ms later, every time it takes the directory over). The stated cause is ruled out: a client's `methods` hands out a handle for any name, and a sub sent before any primary is held and replayed. The only way left is the directory's client compose coming back as a server. Directory.start() now checks that: if it recurs, fero() fails with `#directory: the directory client composed as a <role> — its methods have no lookup (I-19)`. Next to probe: a survivor racing the newcomer for the port (the EADDRINUSE path in `#tryHost`).

### data (the sibling repo, `../data`)

- **The 3-arg `reduce`'s cut-off may ignore a Map accumulator.** Seen once in a review probe on 2026-10-08, not reproduced in a test yet: the deepEq cut-off compares `Object.keys`, so a Map or Set accumulator never looks changed and may never re-emit.

### The website

- **The old Treatise site's claims no longer resolve.** Since V4-15, `~/fero-site/claims.mjs` reports three missing rows (`kernel/node.ts ∌ "digest-on-admit, from BOTH ends"` twice, `∌ "the peer ships the missing"`), and its prose says both sides send a digest. The `next/` site replaced it; reword or retire the old page.

### The debugger

- **A scoped capture paints every node `differs`.** With `replicas` set, each member holds only its own rows, so the fingerprints differ by design. The header says `differs (in flight)` and every node row carries an amber pill (the `scoped` scenario shows it). Compare per row among its holders, not one fingerprint per node.
- **Known limits of the replay**, accepted and written in the fold header of `tools/debug/model.mjs`. A link killed by a fatal frame drop can win a client's primary re-election in the replay for one round trip. Scoped and durable nodes open empty stream lanes with no journal row, so a reborn durable writer's links and streams show `@ end` instead of replaying. `synced` flips one row early when the same step also ships a catch-up.
- **On a scoped capture, a client and a member that left are still painted `never-arrived`.** The holder lists are as of capture end, and only a current member of the writer's view can be called `not a holder`. A client's writes are judged by the old rule, and so is a member that left cleanly or was voted out: both get red stops for rows they were never meant to hold. A fix needs each client's feeder and what it holds, and a rule for non-members. Also, the links-and-streams replay does not fold a hand-off's watermark jump, so a node that acquired a row shows its links and streams `@ end` under rewind.

## Worth doing

### Next

- **The door is designed, not built: the contract hash, the methods-only hint and peer authentication as one HELLO change.** [docs/DESIGN-DOOR.md](docs/DESIGN-DOOR.md) (2026-10-08): HELLO grows once by `c` (a readable cluster contract: `heartbeat.ms`, `replicas`, `methods`, `validation`, `ring`), `m` (methods-only) and `k` (a nonce, only with a secret); one new verb `DOOR` carries an HMAC proof, dialer first; the kernel holds no crypto (`door = { mac, nonce }` is injected like `validation`, so the sim proves the protocol); one config key `secret` (call, `FERO_SECRET`, file; never a flag), redacted everywhere; with nothing set every byte on loopback is as today. Seven questions with defaults wait in its §14; the build starts on the owner's yes. Until then: a client's hello that presents a member's uuid still trips the duplicate-link rule, one box's shell can still set `heartbeat.ms` or `replicas` alone, and a client learns a resource is methods-only only after a round trip.
- **CI and a pinned quiet runner.** The CI file is written but not pushed (V4-29). `.github/workflows/test.yml` runs `npm test` and the counted wire laws on a standard GitHub runner, for pushes to main and for pull requests, with fero and data's v4 branch checked out side by side. It is green locally in that layout against the data commit GitHub has today: 584 + 18 tests, about 6 minutes. The wall-time perf pins still wait for a pinned quiet box (tools/perf/BASELINE.md); after that comes the real v2-vs-v4 socket A/B, with p99s.

### Someday

Each of these is one plain line here; the long form is in `git show 0055e6e:IDEAS.md`.

- **api.** `isolate` / `heal` on the diagnostics handle (a TCP shell cannot hold a partition honestly; the sketch is in docs/DESIGN-M7.md). `seams.validation` goes in the next release (it prints a one-time note now).
- **Kernel.** Suspicion watches link liveness, not ping round trips, so a hung-but-connected process looks alive. When the pending-write queue overflows, the oldest write is dropped and counted; how big the queue should be against the retry horizon has never been measured. A lying disk that lies only about the newest row of a lane escapes the hole detector; chained durable marks would close it. Anti-entropy digests go full mesh every tick, O(n²) frames; pair a fix with announcement-gated anti-entropy. A full-mesh pause burst can drop a whole link queue at once.
- **Scoped replication (the M6 leftovers).** Gating anti-entropy on announced possession and un-pinning compaction are coupled: design them together or not at all. Tombstone GC stays pinned while scoped. Distributed `sum` / `max` / `avg` instead of the materialize-first throw. Spokes subscribe to what they watch, not the whole shard. Explicit-undefined cells across the gather. A push-based claim stream. Chunked transfer for oversized partitions. Smaller HAVEQ bodies. The unscoped two-teacher race. Shed only on durable marks. Disjoint partial sums. Nicer remote handles.
- **Directory.** A failure detector over client links, so a hung watcher's entry does not live for ever. One directory client per process instead of one per instance. A `#directory` node cannot be attached by the debugger: a system compose takes no `diag.allow`. An askable directory (a routable rendezvous) is as unauthenticated as the peer plane: the door is what makes it safe off a trusted network. A failed lookup is never re-subscribed, and on this box's own directory a server's next successful register clears its lookup `error` while the lookup stays dead. `localish()` does not treat IPv4-mapped spellings (`[::ffff:127.0.0.1]`) as loopback.
- **Sim and scale.** Monitor passes walk every lane even when nothing changed (about 15 ms per pass at n=100); scope the walk to the node that stepped. Scale goldens are tied to (n, writes, seed); failure captures at n=100 are triage-grade only.
- **Debugger.** Ship journal deltas over the DIAG wire instead of whole journals. Cache unchanging log entries between rebuilds (never below the node's base). A paged state read with a torn-snapshot marker for a state map over one frame (a too-big answer is already named `frame`). `topologyAt` still joins a reborn writer's rows to the bare lane on purpose: it is the one truthful producer of a replay refusal three suites rely on. A capture that mixes resources (the user's nodes beside the `#directory` nodes) paints every node `differs`, because the fingerprint, the cells and the routes assume one resource; group them by the node's name, which every capture now carries (the `#` tag beside the label still shows).
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
- **V4-13** One ledger. This page holds the status, the bugs, the ideas and the decisions index; the full records live in `docs/`; 42 obvious warts were fixed instead of filed, and the fixes that touched the public surface are listed there. Amended 2026-10-08: a client follows its feeder's view even to a lower number, so `cluster.epoch` on a client is its feeder's number (I-23).
- **V4-14** The ring hash is fnv-1a finished with fmix32, and it is part of the wire contract; mixed versions are unsupported before 1.0.
- **V4-15** The lower uuid opens the admit digest exchange, so a join ships each missing row once; the formation count re-pins 69,400 → 59,500.
- **V4-16** The method plane: a live scalar arrives as `{ value }`; a subscription has a `ready` per attempt and an `onError`; a kernel outcome on an assignment fails the call; a plain-value handler keeps its views.
- **V4-17** The shell's `start()` always settles (typed `stopped` / `started`); a store whose boot record failed mid-life is condemned on restart.
- **V4-18** Overlapping cells: the newer stamp wins across depth. A whole-row write (or row remove) hides every field cell stamped at or below it; a field stamped above it shows on top, in every arrival order, on the screen and in the scoped gather; a row a removed field had made up goes away; a write of ours that commits settles committed once its echo arrives, even when the echo is refused. Arrays are the limit.
- **V4-19** The kernel tune table: every bound and tick count is a row of one frozen `node.tune`, defaults equal to the old constants, bytes and perf proven unchanged; `redial.tries` is its one config key.
- **V4-20** A dead member is dialed 5 times, not 10: eviction in about 4 s instead of 20; a dial that never linked up, and a client, keep the long chain.
- **V4-21** A client's `cluster.writable` is its feeder's gate, carried as `w` on the DIGEST reply to client links (I-33).
- **V4-22** `cluster.writes` is its own handle (`f.cluster.writes.snapshot()` / `.tap()`), published one microtask after an outcome; the cluster tap fires only when the view moves.
- **V4-23** The debugger says what it knows and no more: `not a holder`, `acquired`, `replay unchecked` on a truncated journal, a newcomer's gate is `joining`, a self-proposed leave reads as `leave`.
- **V4-24** The series is 27 rungs: 44-sell is the website's story; a role that reads typed lines gives readline the screen so a half-typed line survives a redraw; a terminal test covers it.
- **V4-25** A fresh ballot of mine never opens below my own last ballot: the double vote latent since M2, re-proven on today's kernel, closed; the leave sweep and the random explorer guard it.
- **V4-26** `validation:` is a top-level key (`seams.validation` is its alias for one release); the `diag` key (`diag.allow.<name>`: call, env, file, never a flag) arms the debugger's attach on a real `fero()`; a system resource wears a `#` tag in the viewer.
- **V4-27** Cross-box discovery: a host with no port asks that box's directory (lookup only), and a server whose listen would leave the box must listen on a routable address.
- **V4-28** A remove of an array's own element is refused `sparse-hole` before it commits, on every path; a view install leaves a member to its running redial chain.
- **V4-29** CI runs the tiers whose results do not depend on timing: `npm test` and the counted wire laws, fero and data side by side; the wall-time pins wait for a pinned box.

## History

[docs/HISTORY.md](docs/HISTORY.md): the v4 status log, day by day, and the v3 milestone record (M0 to M8) from the old README.
