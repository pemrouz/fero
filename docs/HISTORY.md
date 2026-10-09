# fero — the record

This file is the history: the v4 status log (2026-08-01 to 2026-10-09), then the v3 milestone record that the old README carried (M0 to M8, the adversarial reviews, the comparison with v2). Nothing here is a to-do. The live one-page view is [../STATUS.md](../STATUS.md); the settled decisions are [DECISIONS.md](DECISIONS.md).

---

# Part 1 — the v4 status log

*fero v4 = fero v3 migrated onto data v4 (the sibling `data` repo = data v3 +
the W1–W17 wishlist, ALL LANDED — see ../data/STATUS.md). Scaffolded
2026-08-01 as a full copy of `v3/` (fero-v2 tip `1d94ad6`); PROMOTED TO THE
REPO ROOT 2026-08-16 (package `fero` 4.0.0; the v2 surface + frozen v3 tree
live on at the `master` branch tip — v3 stays the A/B reference there). Plan
of record: DESIGN-DATA3.md §4 (design decisions) + §5 (D0–D5), at the
`master` tip under `v3/`; this file tracks the D-phases.*

Run from the repo root: `npm test` (456 on 2026-09-28 before the V4-13 pass, 495 after, 515 then 584 on 2026-10-08, 600 on 2026-10-09 — the live count is in ../STATUS.md; + the 18-clause data contract ride; the directory OFF and
the config layer OFF — utils/battery.ts pins FERO_RENDEZVOUS=off and FERO_CONFIG=off) /
`npm run perf` (43 pins) / `npm run sim:scale` (the n=100 deep-sweep registry,
script-tier). One install step since V4-10: `npm install` (optcascade).

## Migration ledger (D-phases, per DESIGN-DATA3 §5)

| Phase | Scope | State |
|---|---|---|
| D0 | data v4 pinned (substrate imports data's ONE api entry — since both root promotions: `../../data/api/index.ts`); the SCHEDULE suite rides fero CI (`test:contract` chained into `npm test` — now 18 clauses vs data HEAD); cross-version symbol audit clean (the one v2-symbol probe modernized) | DONE |
| D1 | Substrate swap: v4 handle mint, [value] snapshot (fresh-container semantics), applyRec = the HOT LANE (fero Recs verbatim, zero reshape, ORPHAN-CELL VIVIFY preserving v2's auto-vivify replication semantics), records() = connect(anchor, fn) with REAL synchronous dispose, applyStreamRec = tolerant seam ingest (whole-value diff resubscribe rides legally) | DONE |
| D2 | Warts DELETED, not ported: the capture sink, #expected echo match-and-consume, verb-rewrite matching, #healRoot (root replace now throws PRE-COMMIT in the lens); no-op delete filter kept (leaf-read, absence ≡ undefined per clause 10c); scoped facade's hand-copied OPERATORS set → data's exportContract(); fold armor retained (now mostly moot under clause 10) | DONE |
| D3 | The LENS (DESIGN-DATA3 §4.1): fero OWNS the write surface — assignment/delete trap into Bind.issue BEFORE data sees anything (validation covers both by construction, OQ6 kept); reads/operators/RESERVED delegate to the v4 handle; children are nested lenses; v2-parity thenable kept; post-destroy local-value pin kept; cluster fold on .set() (methods-only writes) | DONE |
| D4 | Perf close-out: fero perf suite 36/36 PASS at the v3-era thresholds (api tripwires, alloc gates, absolute probes); the data-side m3 replication gate pins the seam shape (0.171× at frame-16 vs fero's v2 terminal apply) | DONE |
| D5 | Ledger close: DECISIONS record, IDEAS residue, README | open |

## The frames-stack note (D2 review outcome)

The v3 #frames stack SURVIVES — it guards FERO-kernel re-entrancy (a nested
issue() during rt.write's synchronous apply drain), which is independent of
data's clause-5 queue. What died with the substrate swap is only the DATA-side
re-entrancy pathology (the c870bde class): a tap-issued write now defers to the
next data commit (clause 5, pinned by the contract ride) instead of draining
inside the outer apply.

## Known residue (IDEAS candidates, D5)

- Windowed-sort subscription streaming ('move' records) stays client-side-sort:
  the DATA side now supports move round-trips (W1/W3), but fero mirrors are
  keyed (object-born) — positional mirror identity is a mirror-keying redesign,
  not a seam question. Both skips (serve + apply) kept, documented.
- Inbound applies ride the lane per-record (batch-of-1). The m3 gate measured
  even that at 0.547× of the v2 path, so frame-batched apply is an OPTIMIZATION
  (shell frame boundaries → one lane call), not a correctness need.
- fold.ts cell-isolation armor is now mostly moot (clause 10d isolates in-lane);
  kept as defense-in-depth, slimming is cosmetic.

## Baseline

- Post-migration: **297/297 tests + 16/16 contract clauses** (suite unchanged in
  count from the v3 inherit: every behavioral pin — sim sweeps, Q3A hunts ×2,
  TCP/WAL tiers, scoped fault schedules — passes on data v4).
- Migration findings worth naming: (1) the substrate reject-slot needed
  save/restore (effect-phase re-entrancy corrupted it — caught by the M5-review
  re-entrancy pins); (2) the gather's parent-tombstone-then-live-child
  projection (Q3a seed-0 shape) needed the orphan-cell vivify in
  applyStreamRec too; (3) data's registry filter fail-fast had been bypassed by
  W10's dep routing — restored loud (fixed data-side).

## Log

- 2026-08-01 — scaffold: `cp -r v3 v4`, package rename. No source changes yet.
- 2026-08-01 — D0–D3 landed: substrate rewritten onto data v4 (one seam file,
  one import), Bind on the lens architecture, cluster fold on .set(), facade on
  exportContract(), contract ride wired. 297/297 + 16/16.
- 2026-08-03..16 — D4/D5 closed (perf 36/36 at the v3-era thresholds; ledger
  close), then the cross-repo ADVERSARIAL RE-EVALUATION's fero-side fixes:
  the lens write-builtin backdoor closed (set/update/patch/remove route
  through issue(); insert/ingest/raf/dispose throw fero-shaped;
  first()/last() wrap as lenses) and the ./internals entry repaired (the
  deleted capture sink was still re-exported). 299/299 + 18/18 (data's
  contract grew two clauses-worth of pins, SCHEDULE_VERSION 4).
- 2026-08-16 — data promoted its v4 tree to its repo root; substrate
  re-pointed one hop shorter. Then THE FERO ROOT PROMOTION (same day): this
  tree moved to the repo root (package `fero` 4.0.0), the v2 surface + frozen
  v3 tree retired to the `master` branch tip, seam paths flattened
  (substrate `../../data/api/index.ts`, contract ride
  `../data/conformance/schedule.test.ts`). Full battery green post-move:
  299/299 + 18/18 + perf 36/36.
- 2026-08-23 — THE SCALE TIER (n≈100; previous ceiling everywhere was 5).
  Groundwork fixes: cluster()'s declared-but-dead `fault` option now applies
  (three suites had silently run without their chaos — re-verified green
  under the real personalities, timing-neutral A/B); ids pad to
  max(2, len(n)) so lexicographic uuid order — the lowest-uuid proposer
  discipline — survives n≥100 (n≤99 byte-identical, goldens pinned);
  monitor registration idempotent. The enabler: `run({checkEvery})` samples
  the monitor pass (per-event O(nodes×lanes) walks would cost ~30min per
  100-node trajectory; the log-cursor monitors lose NOTHING under sampling;
  default 1 byte-identical, pinned three ways). New tiers: sim/scale.test.ts
  (six n=50..100 headline laws — 100-member one-ballot genesis, single
  proposer, fanout-99 overflow/drain, genesis-stall + staggered-start pins,
  R=3-of-50 inheritance wave), sim/scale-chaos.test.ts (ten n=8..30
  churn/durability models with ENGAGEMENT guards — both fired during
  authoring and forced real fixes to vacuous chaos), sim/scale.perf.ts
  (5 pins: 69,400-event formation golden, O(pairs) flatness ratio 16.43 vs
  16.50, exact k·n(n-1) digest law, 99-apply fan-out count, 20s wall
  tripwire), tests/scale-tcp.test.ts (12-node real-socket dial-storm smoke),
  sim/scale-run.ts + `npm run sim:scale` (11-scenario deep registry; first
  full run 56M+ events ALL GREEN — 9,603 sheds/zero stalls at R=3-of-100,
  peak-epoch 21 = perfect join serialization at 80+20, 2,495 torn WAL rows
  healed, 40 fsync lies detected). One catalogue claim corrected by the
  kernel: a full-cluster restore resumes its view by mutual equal-epoch
  re-confirmation — NO self-ballot (the M4e twin's law, now pinned at 25
  and 100). Battery: 319/319 + 18/18 + perf 41/41.
- 2026-08-23 (later) — the scale tier reaches THE DASHBOARD: three cards
  (scale-formation — cluster(sim,100) + 100 writers on the scenarios page;
  scale-genesis — one ballot/one proposer at 50; scale-overflow — the
  one-drop-per-paused-link law at fan-out 99), schematic diagrams by the
  sweep-card precedent, registry 20/20 (wall 2.4s→7.0s, baseline re-pinned
  with zero counted drift), verified on the REAL page via headless Chromium
  (cards + 100-node viewer click-through + live scrubber, zero page
  errors). Plus scenarios.dom.test.ts — the vm harness scenarios.html's
  header had promised since v3 (8 renderer pins, mutation-checked). NOTE: a
  long-running `npm run debug` serves the registry loaded at ITS start —
  restart it to see new cards (?rerun=1 is not enough). Battery: 327/327 +
  18/18 + perf 41/41.
- 2026-08-23 (later still) — THE v4.1 SURFACE (V4-2): role by DECLARED ACT —
  bare fero(name) is a CLIENT now; server: true / listen / dir / replicas /
  a `data:` seed / any method marks a server; `listen: false` is the
  socketless solo (BREAKING for the old bare-solo shape). The name-derived
  default port (fnv1a32 → 127.0.0.1:[44800,45824), loopback only) behind the
  new HELLO name echo — JK.nameReject (71) closes the silent cross-resource
  merge on a misdial (both ends refuse, dead+noRedial; absent name = legacy,
  frames byte-identical). The boot record carries `uuid` and restore
  recovers it — the silent evicted-heir bug closed (uuid omitted on a
  durable dir minted a fresh identity over the old life's WAL), with the
  config/dir mismatch throw and fero()-time uuid validation (non-empty, no
  '~'). The `data:` seed applies only when the local fold is empty at boot
  (a restore never re-seeds) through the validated lens ingest. f.snapshot =
  the sync dense read on the instance (armed-scoped throws typed;
  JSON.stringify(f.data) stays documented-wrong — toJSON delegation was
  REJECTED, see V4-2). The demo drops every address, identity, and internals
  import (smoke-verified live on the derived port). Battery: 331/331 +
  18/18 + perf 41/41.
- 2026-08-23 (the V4-2 adversarial review) — 4 lenses × 2-stage verify over
  the surface stack; 12 confirmed, all triaged. FIXED: legacy-dir poisoning
  (a v4.0 boot record + omitted uuid now REFUSES with the one-time-upgrade
  hint instead of letting the random default claim the dir and lock the true
  owner out); a non-empty wal.log without boot.json refuses as an incomplete
  dir (the silent foreign-log adoption); restored uuids get the config-grade
  validation; the boot record now carries the resource NAME (the disk twin
  of the HELLO echo — fero('other', {dir-of-'r'}) refuses); a seed row the
  validation seam rejects throws at fero() time, pre-validated whole so a
  partial seed can never persist; a derived-port bind failure names the
  mechanism and TEARS DOWN the half-built instance (bind/host/WAL-fd leaked
  on any start rejection before); explicit listen required when a derived
  (loopback) address would be gossiped to non-local hosts; hosts: [] on a
  client refuses; cluster.me carries role + a client's effective dial
  targets. ACCEPTED AS DESIGNED: the bare-solo→client flip (the V4-2
  breaking change itself); pre-arm scoped snapshot reads locally; nameReject
  churn is heartbeat-bounded and self-heals when the right resource appears.
  Battery: 333/333 + 18/18 + perf 41/41.
- 2026-08-30 — the two-terminal demo's watcher WRITES: a bare client's plain
  assignment (`f.data.gadgets.stock = …` every 4s) rides a WRITE frame to its
  server, is stamped there (origin = the server), and echoes to every watcher
  as ordinary replication — the relay path api/index.test.ts:240-278 pins for
  hosts-listed clients, identical by construction for the bare shape
  (smoke-verified live: the server's frame shows the watcher's write). The
  server's gadgets tick is gone (one writer per cell keeps the demo legible);
  the header's restart claim corrected — anti-entropy reconciles BOTH ways,
  the memory-only server recovers the newer state from its watcher.
- 2026-08-30 (later) — ELI5 TOOLTIPS throughout the debugger: ONE plain-English
  glossary + ONE hover layer ([tools/debug/eli5.mjs](../tools/debug/eli5.mjs),
  plain-JS ESM shared verbatim by viewer.html, scenarios.html and the tests,
  served at /eli5.mjs) replaces the 11 terse native `title=`s with 337
  entries — every tree stat/pill/group, inspector fact/section/table header,
  journal-kind badge (all 71 JK kinds), route stop, cell election row, omni
  filter head/value, status-bar fact, time-travel control, live/attach chrome,
  and on the dashboard every metric key, phase chip, diagram glyph, pill and
  delta cell. Copy was written from a 7-lens source research pass over the
  kernel and then adversarially verified (12 refuters + 3 newcomer readers);
  it explains what a label MEANS and never claims a fact about the loaded
  capture (`data-tip-fact` carries a repeated fact, escaped). Gate:
  eli5.test.ts — no dangling key (a sweep boots the real page scripts over
  every scenario capture, a mid-flight live capture, an overflowed-ring
  cluster, a never-healed cut run to quiescence, an attach envelope with every
  absent reason), no dead copy (an 8-entry documented unreachable list), the
  JK/metric/phase vocabularies pinned both ways. The DOM shim moved to
  dom-shim.ts (shared by viewer.dom/scenarios.dom/eli5 suites) and grew the
  tooltip layer's needs; the wiring test hovers through the registered
  document listener; honesty (d) now pins the TWO-plane import shape (the
  model for every fold, eli5 for the hover mount alone, eli5.mjs importing
  nothing). Six mutation checks (unmounted layer, vanished/typo'd/dead key,
  dropped dashboard key, new JK kind) each turn a suite red. Verified by
  driving the real pages in headless Chromium (25 hovers read back,
  hide-on-leave, zero page errors). The review also surfaced and fixed three
  pre-existing debugger inaccuracies: the stream inspector's Facts rendered
  `seen (high-water) undefined` (the entity never carried `seen` — it now
  shows the watermark ladder it does carry); the lost-ack card drew its
  severed link as a ≋ dup/delay fault (it is a one-shot ✂ cut that heals);
  the frameDrop journal line claimed `— link dropped` for every drop (an
  unknown verb keeps the link). Battery: 341/341 + 18/18.
- 2026-08-30 (V4-3) — THE DIRECTORY: no name hashing. The derived port
  measured badly (1024 slots/box → 50% collision odds at 38 names; one bare
  server per name; a host-less hub made genesis a uuid coin-flip — pinned
  `aaaa` never forms; a dead hub blinded every new joiner). Replaced by the
  `#directory` SYSTEM resource (the `#` prefix is reserved) at the per-box
  rendezvous 127.0.0.1:3376: servers bind a FREE port (port 0 — the shell
  publishes the real address to the kernel before start) and `register`,
  everyone opens `lookup(name)` as a live subscription, and the folded
  addresses feed the kernel's new `discover` event (static ∪ dynamic hosts,
  cached; forgotten targets park at the cap, never closed; static hosts and
  members never parked). Soft state on the method plane: entries die with the
  registrant's link (peer-down cleanup keyed by uuid transitions, read AFTER
  the fold — the mid-fold read dropped registrations riding the same chunk as
  their HELLO), takeover = re-subscribe + re-register on every primary. First
  server to bind hosts; the rest retry the bind on link-down (jittered). A
  user resource may not listen ON the rendezvous; a non-fero squatter is
  survived. Config `rendezvous: addr | false`, env FERO_RENDEZVOUS (the
  battery runs `off`; discovery tests opt in with a free port each).
  cluster.me: `hosts` on every role + `rendezvous {addr, hosting, up}`;
  diag.rendezvous() exposes the directory nodes; Context.peer names a wire
  caller. Pinned: kernel/discover.test.ts (dial/cover/park/re-add/static,
  sim genesis over a discovered set + late JOIN), tests/tcp.test.ts port 0,
  api/directory.test.ts (refusals, 3-round no-pin formation, bare client →
  explicit servers, host death → takeover/failover/NEW joiner/bare restart,
  entries die with their registrant, two names, Context.peer, squatter).
  Spec DESIGN-DIRECTORY.md; DECISIONS V4-3. Battery: 355/355 + 18/18 +
  perf 41/41 (341 + the neighbour-landed ELI5 gates + these 14).
- 2026-08-30 — debugger: links + streams REPLAY under time travel. The
  100-node scenario's scrubber moved keys@t/jrnl@t but every node painted
  99/99 links and 65 streams at t=0 — the tree/inspector read the capture's
  END snapshot (diagNode's link table/watermark ladder carry no t), and the
  only statement of that lived in the inspector banner, hidden with nothing
  selected. Now `topologyAt(capture, uuid, t)` (model.mjs) replays the link
  lifecycle (linkUp/identified/dupLink→closing/linkDown/pause/drain/
  dropOldest/digestIn/diagAuth, the client single-feeder rule via the new
  additive `client` field on diagNode/captureNode/attach) and the watermark
  ladder (writeLocal/applyInbound/gateDrop; durable claimed only where
  provable, queued-while-paused an explicit unknown); `verifyTopology` is
  its drift guard (the fold at t=∞ must reproduce every captured end table —
  all 20 registry captures, every node, pass) and the viewer replays a
  node's topology ONLY where that proof holds, else the end tables stay,
  labelled `@ end` with the reason (a reborn durable writer — I-1's `uuid~2`
  lane — is the truthful fallback producer in the ELI5 sweep). The
  adversarial review's per-step oracle (kernel snapshot after EVERY step vs
  the fold at that row, 60+ seeds) found what the ∞ guard cannot: `walTaint`
  (condemn wipes streams/state — both replay planes now honour the row);
  leaf rows of a refused node painted unlabelled end facts (inspector +
  status bar now say `@ capture end` with the reason); a selection scrubbed
  to before it existed was dropped (kept now — the pane says "not here
  yet"); fields an older capture cannot vouch for ride the verdict as
  `unverified` and paint as unknown; `routes` minted `''` for a partition
  no writeLocal row named (null now). Documented bounds (ISSUES): a fatal
  frameDrop's dead link inside a client's re-election window, armed/durable
  lanes minted without a row, synced settling at the end of the digestIn
  step. Pinned: model.test (t0 empty / ∞ exact / closing loser / paused
  unknown / paused-digest no-sync / client single-feeder + failover /
  durable unknown / walTaint reset / refusal templates), honesty (empties,
  traceability at linkUp + dupLink rows with the `''` carve-out scoped to
  the topology fold and proven exercised, typed refusal templates, the
  reborn producer, import pin), viewer.dom (links 0→mid→full on formation +
  scale-formation n001 0/0→mid→99/99, streams 0→full; the verdict honoured
  on every surface, is:info finds `@ end`, kept selection), eli5 (six new
  keys reachable, `not-captured` now truthfully reachable), diag/attach
  parity pins `client` and refolds the topology of a wire-pulled slice.
- 2026-08-30 (V4-3, the implementation panel) — 5 lenses × a skeptic per
  finding over the landed directory: 25 confirmed (8 major, every one
  reproduced), 0 refuted. Fixed: the squat strand (the string-compare listen
  guard was bypassed by `0.0.0.0:3376` / `localhost:3376` / `rendezvous:
  false` → `sameSocket` refuses every spelling against own/default/constant,
  AND the kernel parks a name-rejected dialed target given-up so heartbeat
  revival re-dials it — the V4-2 "heartbeat-bounded churn" claim is true
  now); owner keys split on the first space (names with spaces never cleaned
  up → JSON keys); cleanup by (name, uuid) with no ownership (a dir-restored
  identity re-registering past its wedged predecessor lost its cell when that
  socket closed → per-cell `owner`, later wins); the battery's isolation
  lived in one npm script (`FERO_RENDEZVOUS ??= 'off'` pinned in every
  non-directory suite); the fold-order defect had no deterministic pin
  (`hostMethods` exported as a seam; GRACE / ownership / space-name / cap
  unit-pinned); the bind retry composed a full Runtime 4–20×/s against a
  held port (probe-gated, exponential to 5s, errnos on
  `cluster.me.rendezvous.error`); discover's park forked the redial chain on
  re-add (the armed timer is cancelled; entries nothing names are dropped, so
  #backoff is bounded). Minors: `listen: false` read as "down" (now `false`),
  env garbage refused at fero() time, isAddr strict, precedence documented,
  try/finally shapes, a derived takeover bound. Documented not fixed: the
  loopback trust boundary, hung-but-connected registrants keep entries, ref'd
  shell timers. Battery: 372/372 + 18/18 + perf 41/41.

- 2026-08-31 — THE DEMO, SPLIT AND RECORDED: examples/two-terminals.ts now
  dispatches to examples/server.ts + examples/client.ts (shared demo-ui.ts);
  the client writes back (a sale every 4 s by plain assignment). The site's
  hero replays a RECORDED run of exactly these files (scratch site/record.mjs,
  22 s: seed → watch → sale → SIGKILL → restart on a new port → redial) and a
  checker asserts the panes only ever paint recorded frames. The run
  reproduces IDEAS P2 (overlapping cells) — noted there. Battery green.

- 2026-09-05 — THE RELAY VALIDATES (IDEAS Security, step 1; DECISIONS V4-4):
  a bare client's plain write relayed through its primary now meets the
  server's `seams.validation` at the relay ingress (kernel/write.ts onWrite,
  ae 0 — `NodeOpts.validate`, handed down by the composer). Before, a server
  that refused its OWN `data.admin = …` let a client's LAND and read
  `committed`. A refusal is a fourth, TERMINAL NACK class — WNACK
  `{r:'invalid', m: reason}`: the issuer drops the attempt for good
  (`Writes.rejected` + `rejectedPending`; `Bind.sweep` — the droppedPending
  probe, widened — reads the reason off the composer's post-step fold, since a
  WNACK step applies nothing), so the client's promise rejects with the
  server's reason and a plain assignment bounces; a relay hops it onward; a
  committed retransmit skips the check (dedup window). No validator ⇒
  trajectories byte-identical. Two adjacent forgeries closed with it: the
  relay keys on `link.client` (a client forging ae = epoch is relayed, not
  admitted to the owner leg unvalidated) and ACK/NACK frames on a client link
  are dropped. Honest scope: a bound on the fero client's write surface, not
  peer auth (a forged RECORDS frame from a spoke still lands — filed under
  the r:1 item). Pinned ×7 (kernel/write ×5, sim/client, api/index — the
  probe), each mutation-checked. Step 2 (the opt-in methods-only door) is
  under design review — see IDEAS. Battery: 379/379 + 18/18 + perf 41/41.

- 2026-09-06 — `methods:` IS THE DOOR; SPOKES ARE VIEWS (DECISIONS V4-5). The
  one spelling for hosted methods is now `methods: { sell(arg, ctx) {…} }` —
  a top-level function throws with the pointer — and its presence PROTECTS
  the resource: every relayed client write (assignment, delete, the
  builtins, methods.update/insert/remove — one ingest) bounces with the
  terminal reason 'methods-only'; the server's own writes and its handlers
  stay trusted (and still meet seams.validation); reads stay open. Zero
  kernel change: the door is a degenerate predicate folded into V4-4's one
  hook. Open or protected, nothing in between (the panel's `writes:` key and
  reopen list REJECTED). A validator-refused write inside a handler now
  FAILS the call (`write refused (<cell>): <reason>`; ctx.flush() throws it).
  The spoke hole closed: a client never ships a suffix, a server drops
  RECORDS on client links, and a spoke AHEAD of its feeder RESYNCS to the
  cluster's truth (fold reset → empty r=1 digest → the r=0 reply completes:
  ghosts removed downstream; journal resync/resynced, the debug fold model
  treats resync like walTaint). The `#directory` host is protected for free.
  BREAKING within 4.x: `fero(name, { sell: fn })` → `methods: { sell }`.
  Battery: 385/385 + 18/18 + perf 41/41.

- 2026-09-05 — THE EXAMPLE SERIES BEGINS: examples/01-three-servers is the
  pattern every later example follows — one folder, one file per terminal
  (`node server.ts`, no flags: Node ≥ 22.18 / 23.6 strips types itself), a
  `check.ts` that runs the terminals as children bounded by
  FERO_EXAMPLE_TICKS, asserts on the lines they print, and ends with `ok
  <example>`; examples/lib.ts holds the plain-Node plumbing (ticks, onExit,
  until, logChanges, spawnRole, story — zero fero code) so a folder plus
  lib.ts is copyable. tests/examples.test.ts runs every check.ts inside
  `npm test` under a PRIVATE rendezvous port per example (the battery stays
  FERO_RENDEZVOUS=off; grandchildren inherit the port), with a per-example
  budget and a process-group kill in `finally`, plus a drift guard (check.ts
  + README present, listed in examples/README.md, no #utils/internals
  imports outside the debugger series). 01 itself: `server: true` run three
  times forms a view through the directory and each copy's own row (keyed by
  its uuid, whole-row style) shows on every screen; the check kills one
  (writes keep committing on the majority), starts the file again (a NEW
  identity joins and catches up) and SIGTERMs the rest (clean destroy). It
  was "run it twice" first: the user's by-hand run showed why not — a
  two-member view cannot evict its dead half or admit the returning one, so
  the survivor wedges at `writable false` forever (DECISIONS V4-3's rule,
  now the example's banner). Battery: 386/386 + 18/18.

- 2026-09-07 — THE GRACEFUL LEAVE (DECISIONS V4-6): a clean `destroy()`
  now asks the view for a ballot WITHOUT itself before it tears down — a
  `leave` stimulus + a LEAVE verb (25); the leaver proposes when it is the
  lowest live member, else knocks LEAVE on every member link and the lowest
  proposes; its own grant is the old-majority vote a dead member never has,
  so a two-member view loses one member cleanly and the survivor is
  writable ALONE. The leaver goes on a survivor's VIEW echo (the exit
  proof), or after LEAVE_TICKS (4) like a crash (`left` b=0 — suspicion +
  eviction follow as before); Runtime.leave() caps it in wall-clock so
  destroy() cannot hang. A leaver never knocks JOIN back in; its ballot
  rebases on a newer view; the last member simply goes. `diag(f).crash()`
  is the no-leave teardown (a process death) for tests and failure
  stories. Journal `leave`/`left` + ELI5; sink `left(clean)` optional
  (the sim records it). Example 01: banner + README now say Ctrl-C of one
  of two WORKS (a real two-copy paste) while a CRASH of one of two still
  wedges — three plus `dir` stays the rule; lib `coalesce` renders the
  cluster line once per turn (its fields land one record at a time). Born
  from the user's question "why does a cluster of 1 or 2 not work" — the
  option catalog and the rejections are in V4-6. Battery: 396/396 + 18/18
  + perf 41/41.

- 2026-09-12 — 01 IS TWO SERVERS AGAIN: `examples/01-two-servers` (was
  01-three-servers). Three was only ever a workaround for the two-copy wedge;
  the graceful leave (V4-6) removed it, so rung 01 is back to the user's
  original ask — one file, run it twice. The check now STOPS a copy cleanly
  (SIGTERM) and asserts the survivor prints `members 1 writable true` and
  keeps committing alone, then a new copy is voted in (`members 2`) and
  catches up, including the stopped copy's row; ~20 s faster (no eviction
  wait). The README carries the real two-copy run from both terminals and
  states the limit: two survive a clean stop, not a crash — three plus `dir`
  is rung 13. Battery: 396/396 + 18/18.

- 2026-09-12 — RUNG 02, A SERVER AND A CLIENT: the committed demo split
  moved into examples/02-server-client (server.ts, client.ts, demo-ui.ts;
  two-terminals.ts deleted — `npm run demo` / `demo:watch` run the two files
  directly). The two footguns the plan's critic found are gone: the server
  rewrites the WHOLE widgets row in the seed's style (never a leaf on a
  seeded row — IDEAS P2), and the client's sale is a FACT row (one new row
  per event, never a read-modify-write of gadgets.stock); the server's
  screen counts sales with a live `filter().length()` and shows `watchers`
  from cluster.peers; demo-ui's render skips an unchanged picture (a local
  write applies once now and once as its echo). The check starts the CLIENT
  first (a bare client waits, `(down)`), then the server; asserts the rows
  arrive, the label names the server's port, two sales reach the server and
  echo back, the seeded gadgets row is untouched, both exit 0 by
  themselves. README: real frames from a kill -9 + restart run, including
  the honest part — a memory-only restart re-seeds and the watcher's earlier
  sales vanish when it resyncs (V4-5) — `dir` is rung 12. The website's
  hero inlines these two files by path and replays a recording of them:
  paths, prose, claims and the recording were redone in the same sitting
  (scratch ~/fero-site). Three skeptics then reviewed the rung against the
  source and five things were wrong and are fixed: the footgun's stated
  mechanism (post-V4-5 it is the watcher's RESYNC deleting the stale leaf
  from the re-seeded row — the watcher's row loses the field — not the
  re-seed landing on the leaf); "a write applies twice" (true of a
  client's write, not a server's — its echo is a same-reference no-op at
  data's chokepoint); the label printed `hosts` under the word `peers`
  (now `servers`); the check's `(down)` assertion was a boot transient
  every client prints (now it must STAY down with no rows before the
  server starts) and its "echoed back" line was satisfied by the
  client's own optimistic copy (reworded; the server's count is the
  proof); and a check run by hand on the box directory met the user's own
  terminals — lib's `privateDirectory()` now gives every check its own
  free port (01 too). Battery: 397/397 + 18/18.
- 2026-09-13 — NO GHOST (DECISIONS V4-7): a write shows when it COMMITS,
  never before. The user asked whether client writes were applied
  optimistically by default — they were: every accepted record, on every
  role, projected into the local proxy before the kernel saw it, with no
  switch — and chose "only a server owning and writing should commit". The
  optimistic overlay in api/data.ts is deleted, not ported (#optimistic,
  #revert, the never-set `fromCapture` switch, the branch that hid foreign
  commits under an in-flight cell): the proxy IS the confirmed fold; a
  server's write to a cell it owns shows inside the assignment (the commit
  is synchronous); a forwarded write — a client's, or a server's to a cell
  another server owns — shows as the owner's stamped echo; a refused write
  never shows; an in-flight write is only a `pending` row of
  cluster.writes. What survives is a settlement index (cell → newest
  pending cid) that decides promises only, and the lens asks it before
  swallowing a delete as a no-op (`data.k = v; delete data.k` still issues
  the remove). Kernel and wire untouched; one apply fewer per issued
  record. Wording followed: the examples' "shows now and again as its
  echo", the 02 check's optimistic-copy comment, types/README/CLAUDE's
  "bounces". Tests: api/data.test.ts (the forwarded-write pin INVERTED,
  the delete-in-flight pin, a CLIENT-role binding pin — WNACK invisible,
  echo visible), api/index.test.ts (the three client pins inverted).
  Battery: 399/399 + 18/18 + perf 41/41.
- 2026-09-14 — V4-8: THE MINIMAL EXAMPLES, AND THE TWO FERO CHANGES THAT
  MADE THEM POSSIBLE (DECISIONS V4-8). The user found rungs 01/02 "a little
  bit overwhelming" and asked for the most minimal, fun version that scales
  down and up, and whether fero should absorb lib.ts's helpers. Four of the
  nine helpers had leaked into the role files; two were fero's fault. So:
  (1) Ctrl-C / SIGTERM is a clean stop built in — one listener per signal
  for the module, every live instance destroy()s (leave, then teardown), the
  process exits 0 unless the app has its own listener; `signals: false` opts
  out; destroy() idempotent; `crash()` untracks. (2) The cluster view folds
  in ONE data batch (`batch` re-exported through the ONE seam) and sets only
  what changed (signatures for members/peers/partitions), so a bare
  cluster.tap fires once with the whole picture and never for a no-op
  refold. (A third change built here — an echo skip so a client's own write
  paints once — was dropped: V4-7, no ghost, landed underneath it and
  removed the second apply at the source.) Pinned by three composer tests
  incl. a real child process with no signal code getting SIGINT; each
  mutation-checked; perf pins unchanged. The
  examples were rebuilt by a design panel (three angles, two skeptics each,
  synthesis by hand after the panel hit a usage limit): 01/server.ts is 8
  code lines, 02's shop/watcher 9 and 8, no cluster tap, no renderer, no
  dedupe, no tick bound, no exit hook; lib.ts is four check-only helpers
  (`stop()` bounds a role's exit so a broken clean stop fails instead of
  hanging); READMEs under fifty lines with real screens; index rewritten.
  The skeptics found and the READMEs now say: eviction of a kill -9'd
  member takes ~20 s (the redial chain — IDEAS), `dir` restores on a fresh
  port, a joiner prints `members 1 writable false` for a moment, two seeded
  servers would fight over one row. Filed: ISSUES I-19 (a directory-client
  race after a fast host restart: `c.methods.lookup is not a function`,
  seen once in eight). And a real kernel bug: two skeptics saw, about one
  run in five under CPU load, a clean SIGINT of one of two leave the
  survivor at `members 2 writable false`. A sim hunt found it — `leave()`
  answered "nothing to leave" at once while the leaver held no view yet,
  though it had already granted the genesis ballot and the survivor had
  installed the two-member view; no LEAVE, nothing journaled, exit 0 —
  and fixed it: "nothing to leave" needs evidence (V4-6 amended; ISSUES has
  the fixed entry and I-20 for the second mode, a survivor stalled across
  the leave window). Three sim regressions, red on the old kernel; 6/80
  real-socket wedges under load before, 0/80 after. The website's hero inlines 02's files: claims
  re-anchored, the phase finder follows the new header, re-recorded on a
  quiet box, rebuilt, checked, republished. Battery: 405/405 + 18/18,
  perf 41/41.
- 2026-09-19 — V4-9 (DECISIONS): `fero.spawn(file, args?)` is public — the
  other terminal, from code — and the checks meet the box directory
  (`privateDirectory()` dropped: "just examples, shorter is better"). The
  V4-8 signal registry moved to api/signals.ts and is generic, so a
  spawned child is stopped on the parent's Ctrl-C like a live instance; a
  parent that dies on an error SIGKILLs its children on 'exit'. The review
  panel found a V4-8 hole this made reachable from one keystroke — destroy()
  untracked at its START, so a second SIGINT mid-leave (a terminal's Ctrl-C
  reaches a spawned child from the tty AND from the parent's stop()) killed
  the child by signal; now a stop untracks when it settles. lib.ts is
  `until` + `sleep`.
  Three tests over real processes (api/spawn.test.ts); both checks green
  by hand on the box directory and on a private port. Battery: 408/408 +
  18/18.
- 2026-09-19 — V4-10: THE CONFIG LAYER (DECISIONS V4-10). The owner's copts
  module, published as `optcascade` 1.0.0, is fero's first npm dependency
  and `api/config.ts` is its ONE seam. A public `fero()` now folds six
  layers into the call, highest first: `--fero.<key>` > the call >
  `FERO_<KEY>` > the project `fero.opt.ts|js` > `$HOME/fero.opt.ts|js` >
  the default; inside every layer a value scoped to the resource name
  (`--fero.shop.dir`, `FERO_SHOP_DIR`, `{ shop: { dir } }`) beats the
  global. Keys are nested lowercase words so one spelling survives every
  layer: `heartbeat.ms`, `redial.ms`, `journal.cap` — the camelCase
  spellings are refused with the pointer from every layer (BREAKING within
  4.x, the V4-3 rule); seven suites and the directory's two system
  composes renamed. The layer owns what optcascade cannot know: the
  declared schema (unknown keys throw naming their spelling in that layer
  with the nearest key; in the global rung of a string layer an undeclared
  object is another resource's subtree and is skipped unless it is a near
  miss), the carriers table (`methods`, `seams.validation`, `signals` are
  the call's alone; `uuid` never from a file), the coercions for the
  string layers only (`hosts` CSV, `off/false/0`, `server 1/0`, a numeric
  `uuid`/`dir` refused), and `from(key)` — every composer refusal now names
  its source, the legacy `FERO_RENDEZVOUS='garbage'` text kept. New in the
  composer: `server: false` is the client pin from any layer (a marker then
  throws naming both sources — closes the IDEAS `client: true` line), shape
  checks on the three numbers (a string layer can carry `abc`), and
  `diag(f).config()` returning `{ value, from }` per leaf. System resources
  bypass the layer. `FERO_CONFIG=off` = the call alone with zero optcascade
  calls; `utils/battery.ts` pins it and `FERO_RENDEZVOUS=off` for the whole
  battery (imported first by every composing suite, `--import` in the npm
  scripts). Tests: api/config.test.ts (13, injected sources), tests/
  config.test.ts (over real children with `FERO_CONFIG` deleted: a
  project file, a flag over it, a flag alone making a server, two
  resources two dirs, a `$HOME` file, every refusal's source, the sticky
  client pin, the door's defaults, `off` for real; plus three guards: no
  `fero.opt.*` in the checkout, the tracked lockfile pins optcascade, the
  README table names every leaf). Adversarially reviewed before landing
  (four lenses, 26 findings folded in: null-prototype schema tables, the
  own-name and sibling-name rungs, the sticky pin, '' = unset everywhere,
  dotted keys refused, a fero-prefixed minimist error, `--FERO.*` refused,
  the battery's pins by plain assignment).
  Perf: api/config.perf.ts, two tripwires (~30 µs per resolve, ~3 µs off;
  construction only, nothing on the write path); the existing pins
  unchanged. `engines.node >= 22.18`. Deferred to IDEAS: the kernel tune
  table, the `diag` key, a HELLO hash of the contract keys, three
  optcascade wishes. Battery: 431/431 + 18/18, perf
  43/43.
- 2026-09-20 — Examples, V4-11 (DECISIONS): the README template (one
  block per terminal, the command first, real contiguous output, `^C` at
  column 0, at most three bullets, a `sh` block of scale-it commands, the
  check as one sentence, `Next:`) and the screen rule (a sequence rung
  logs one line per change; a live-picture rung clears and redraws a frame
  headed by the role word in CAPS; every screen names its pid) applied to
  01 (pid once, `members N <object>`, numeric rows, `writable` gone — it
  never printed `false` in 01's story) and 02 (the `fero two-terminal
  demo — ` prefix gone, the shop names its pid; the site's recorder, page
  and checker split on the role word, re-recorded, claims re-pinned, and
  the page's V4-10 staleness fixed: `heartbeat.ms` / `redial.ms` /
  `journal.cap`, `server: false` next to a marker is the refusal, one
  "layers" line). Rung 03-one-write built: a client's write is a request —
  `client.ts` renders the last three `cluster.writes` rows from a cluster
  tap (a pending write changes nothing in `data`), `server.ts` only stamps
  and shows; the check pins pending-forever alone, one-fold commit stamped
  by the server's id, the wait-again after a clean stop, the next server
  stamping and the client taking its truth. api/spawn.ts unchanged (the
  echo is the smoke tier's failure evidence). Battery: 432/432 + 18/18.
- 2026-09-21 — optcascade 1.1.0 is published, and fero pins `^1.1.0`. The
  owner published the 1.1.0 this repo's V4-10 review wrote into `../copt`
  (flag keys lowercased at every depth; minimist's bare TypeError rethrown
  as `optcascade: bad flags — …`). The lockfile moved to 1.1.0 and the
  range to `^1.1.0`; with that, api/config.ts dropped its own `--FERO.*`
  refusal (it existed only because 1.0.0 parsed an uppercase prefix under
  another name and silently ignored it): a flag's key is now read
  lowercased at every depth like a variable's, so `--fero.Dir`, `--FERO.dir`
  and `FERO_DIR` are one key. api/config.test.ts asserts the 1.1.0 text
  (the pointer names `'redialms'`; a bad flag set is named by both fero and
  optcascade) and that the three spellings agree — the unit case doubles as
  the version guard, since 1.0.0 would refuse `Dir` as unknown. README,
  DECISIONS V4-10, DESIGN-CONFIG §11, IDEAS (the wishes that remain) and
  CLAUDE.md say so. Battery: 432/432 + 18/18. Perf: 42/43 on this WSL2
  box — the miss is kernel/ring.perf.ts's holdersOf tripwire at ~830–900
  ms against its 800 ms ceiling, which fails on committed HEAD too (826
  ms one run, green the next); kernel/ is untouched and the ceiling is
  not widened.
- 2026-09-28 — THE EXAMPLE SERIES IS COMPLETE (DECISIONS V4-12): 26 rungs,
  01 → 43, every `Next:` a real link and 43 ending "That is the series."
  The eighteen commits of 2026-09-22 (ffce4ae…175cf96) landed 04-17 (rows,
  views, numbers, ordered, methods, live, confirm, validation, durable,
  cluster-of-three, failover, static-topology, scoped, lww-honesty) and the
  debugger series 20-23 (inside, journal, time-travel, live) with no ledger
  line; today's five commits land the capstone and the apps: 30-fleet-audit
  (`node fleet.ts` is the story on one box — three durable members on fixed
  addresses with `methods: { record, prune }` as the door, three sensors
  writing a fact a second and keeping a ledger of what each reply proved,
  kill one / the same command brings it back as itself / kill all three /
  restore from the disks, then the audit through member-pinned readers: the
  three agree, every `persisted` receipt is on every member, no phantom
  rows, the unproven receipts counted and landed, `prune` last;
  `dashboard.ts` is the reader's second terminal), 40-chat (a message is a
  new row written by `post` on the server, which stamps `at` and `from` and
  throws `too long`; every joiner sorts the rows itself with a tiebreak),
  41-kanban (an OPEN server with `seams.validation` and every editor
  carrying the same `rules.ts`; two fields of one card from two writers
  both land; a whole row or an unknown column is refused, an editor's own
  before it leaves), 42-web-bridge (a bare fero client plus `node:http`:
  `/events` streams `connect` records to each tab, a form post becomes a
  whole-row write, `dir` keeps the seed from landing over a browser's rows),
  43-ledger (transfers as rows on three durable members, `transfer` folds
  the balance and throws its rule, the intent rides in the row and the
  notifier — a client of `ledger`, the server of `notices` — clears it
  through `notified`; a member SIGKILLed mid-run comes back as itself with
  every id). Each was built against the V4-11 brief, attacked by a skeptic
  and fixed (2026-09-22), then attacked once more at HEAD before landing:
  the final skeptics found the capstone's clean stop hanging under load (a
  shell bug — the listener kept accepting during the WAL flush and
  `#accept` had no `destroyed` guard; fixed in 717441e with a regression test
  in tests/tcp.test.ts, ISSUES I-21), its prune audit counting rows
  instead of checking what survived, 40's check never running `join.ts`,
  and five README claims to tighten; all applied, three mutations re-proven,
  15/15 tmpfs runs green. Budgets from this box's 9p mount (where `npm test`
  runs): 30 → 100 s (~34 s), 43 → 60 s (~13 s); no slow tier, no
  `test:examples`. The builders' warts from all four phases were verified
  against HEAD by five agents and filed: ISSUES I-22…I-40 open (membership
  genesis coin-flip and the spoke-teaches-a-view wedge, fnv ring skew, the
  lens in arithmetic, the scoped hint, a live scalar on SUB, open-then-call
  order, undisposed SUB views, `update({ key: undefined })`, two spellings
  of origin, `me.hosts`, a client's `writable`, the directory's stale entry,
  a `FERO_*` leaf clobber, a deleted WAL dir, data's `distinct()` and 3-arg
  `reduce`, two viewer faults), I-21 fixed, 25 IDEAS lines, 12 drops; an
  I-10 addendum (three READMEs paste the banner). Ledgers: CLAUDE.md
  (counts, the examples row), STATUS head, README "Run it", examples/
  README.md (the tiers line). Not done: the website still inlines 02 only.
  Battery: 456/456 + 18/18. Perf: 43/43, unchanged (the shell fix
  is on the stop path, not a hot one).

---

# Part 2 — the v3 lineage (from the old README)

# fero v3 — M0…M8: kernel, replication, membership, writes, durability, the fero() api, scoped replication, debug tooling, hardening

> **fero v4 — NOW THE REPO ROOT** (promoted 2026-08-16; the v2 surface and the frozen v3 tree live on at the `master` branch tip). This tree is fero v3 MIGRATED ONTO DATA v4 (../data — the sibling repo, whose own v4 tree was promoted to its root the same day; the DESIGN-DATA3 wishlist, all landed). See [docs/HISTORY.md](HISTORY.md) for the migration ledger; the inherited milestone log below describes the v3 lineage this tree carries.

The from-scratch rewrite of fero-v2, built to plan-v3.md (`master` branch tip). This folder
holds **M0** (the deterministic kernel + thin I/O shells + simulation executive,
proven **both ways from the same kernel bytes**), the **M1 replication slice**
(per-cell LWW + Lamport clock + per-origin logs + digest anti-entropy, so tail loss
from partitions, dial races, and backpressure overflow all HEAL), **M2 membership**
(committed views by joint-consensus ballot + the CP write-gate), the **M3 write
pipeline** (ring ownership over the committed view, forwarded attempts with cid
dedup + typed NACKs — the single-writer invariant v2 spent DECISIONS AA chasing,
now a per-event monitor), **M4 durability** (the watermark ladder, the WAL + boot
record + snapshot/truncate behind an effect seam, the confirm guarantee ladder,
compaction, and the restore-from-WAL-only proof: kill −9 a whole cluster at any
seed and zero persisted-confirmed writes are lost), **M6 scoped replication** (R-sets,
keep-until-confirmed shedding, the one-teacher handover, owner-scoped folds and the
gather — hardened by a 55-finding adversarial review whose centerpiece is the pp
floor law), and **M7 debug tooling, full** (the authenticated DIAG wire channel, the
trajectory shrinker, the Symbol-keyed `[diagnostics]` handle, the 5-node live dash,
and the honesty promotion gate) over a debug tool (capture → typed model → viewer with
time-travel replay) that has co-evolved with the protocol since M0 — each piece pulled
forward exactly when a seed sweep or review demanded it, which is the architecture
working as designed.

- 2026-10-08 — the first wave of the STATUS work plan (the 2026-10-03 plan, the
  owner's answers of 2026-10-05): V4-14 the ring hash finished with fmix32 (a
  spread pin and a golden), V4-15 the one-opener admit (formation 69,400 →
  59,500), V4-16 the method plane (a live scalar as `{ value }`, `ready` per
  attempt + `onError`, a kernel outcome fails the call, the I-29 residue stays),
  V4-17 `start()` settles + the condemned store; data: reduce clones its init,
  distinct() keys objects by structure, za's tiebreak line. Six lanes in scratch
  worktrees, each reviewed by a second model; the I-20 lane went to a second fix
  round; its client-view half (a client follows its feeder, I-23 amended)
  landed on its own. 515/515 + 18/18, perf 43/43.
- 2026-10-08 (later) — wave 2 of the STATUS plan: V4-19 the kernel tune table
  (kernel/tune.ts; a 200-seed trace diff and interleaved perf A/Bs prove it the
  same kernel), V4-20 a dead member dialed 5 times (eviction ~4 s, examples 13
  and 14 re-recorded), V4-21 a client's `writable` from its feeder's digest,
  V4-22 `cluster.writes` as its own handle and on time, V4-23 the debugger's
  holders / acquired / truncated / joining / one leave spelling, V4-24 the
  44-sell rung + the half-typed line + a real-terminal test, V4-25 the
  #nextEpoch double vote closed with a leave sweep and a random explorer. The
  I-20 pledge branch is parked (docs/DESIGN-LEAVE.md). 560/560 + 18/18, perf 43/43,
  sim:scale green. Then V4-18, overlapping cells (the newer stamp wins across
  depth; a per-ancestor cell index; the `lost` settlement effect; the gather
  folds by depth; a sim object oracle), after four review rounds: 584/584 + 18/18,
  perf 46/46, sim:scale green.

- 2026-10-09 — wave 3 of the STATUS plan: V4-26 `validation:` top-level + the
  `diag` key + the `#` badge, V4-27 cross-box discovery under the explicit-listen
  rule, V4-28 the `sparse-hole` reject + the install-dial fork, V4-29 the CI file
  (unpushed). The door (contract hash + methods-only hint + peer auth, one HELLO
  change) is a design record, docs/DESIGN-DOOR.md, from a three-proposal panel;
  nothing built until the owner answers its §14. 600/600 + 18/18, perf 46/46,
  sim:scale green.

## The debug tool

One journal, one model, replay for free (plan §8) — every piece exists because the
kernel is deterministic and the journal vocabulary predates the code that emits
into it:

- **Capture** ([tools/debug/capture.ts](../tools/debug/capture.ts)): per-node journals +
  per-origin record logs + end state + watermarks + link tables, values made
  JSON-safe (NaN/±Infinity/-0/undefined/bytes survive). The event vocabulary rides
  INSIDE the capture (generated from the kernel's `JK` const), so a capture is
  self-describing and viewer filters structurally cannot drift from the wire.
  Sim failures write captures automatically — **tests ARE debug artifacts**: a
  failing seed's report opens in the viewer as a rendered timeline.
- **Model** ([tools/debug/model.mjs](../tools/debug/model.mjs)): plain-JS ESM imported
  by Node tests AND served raw to the browser — ONE file, so v2's dual-language
  fold drift (a real bug fixed twice) is impossible. Folds: the **write-route
  join** (origin → applied / lww-lost / duplicate / never-arrived, per node — v2's
  flagship feature that its wire format made impossible), **contested cells**
  (every LWW election with candidates and the fold-consistent winner),
  **stateAt(t)** (true time travel: replay journal+logs through the same LWW rules
  the kernel runs), and **verifyReplay** — the replay-refold check: the model's
  fold must reproduce every node's captured end state exactly, proving both
  capture completeness and model/kernel agreement on every capture opened.
- **Debugger** ([tools/debug/viewer.html](../tools/debug/viewer.html)): the v2
  explorer idiom (outline tree + inspector + ONE omni filter), rebuilt on v3
  captures. LEFT: a filterable tree — Nodes (→ links, streams), Writes (every
  (origin, seq) with its cluster-wide outcome), Cells (values + provenance +
  divergence), Violations. TOP: one omni box whose facet grammar
  (`is:crit`, `node:n01`, `write:lww-lost`, `kind:aeShip`, …) prunes the whole
  tree at once, auto-expanding to matches — `kind:` values are generated from the
  capture's embedded vocabulary. RIGHT: the inspector — a node's journal
  (human-readable, newest first), a write's change record + per-node route
  timeline, a cell's LWW election with won/lost candidates. Bottom bar:
  breadcrumb + health rollup (converged / replay-verified / violations) + the
  time-travel scrubber (state at any event index, replayed through the model's
  LWW fold). Keyboard: j/k/h/l, `/` to filter, Esc. Honesty by construction:
  renders only folded facts, absence renders as absence, journal truncation
  disables time-travel loudly instead of reconstructing fiction.
- **ELI5 tooltips** ([tools/debug/eli5.mjs](../tools/debug/eli5.mjs)): hover anything
  on either page — a stat, a pill, a journal-kind badge, a route stop, a metric
  key, a phase chip, a header fact — for a plain-English card (one term line,
  one or two sentences in the house words: computer, diary, ticket number,
  record book, member list, tie-break). ONE glossary + ONE hover layer, plain-JS
  ESM shared verbatim by both pages and the tests, the same way model.mjs is:
  every `data-tip="<key>"` resolves there or paints nothing. Copy explains what a
  label MEANS and never asserts a fact about the loaded capture (a repeated fact
  rides `data-tip-fact`, escaped, as a dim second line). `eli5.test` polices it
  both ways: every key either page paints must resolve (a sweep boots the real
  page scripts over every scenario capture, a mid-flight live capture, an
  overflowed-ring cluster, a never-healed cut run to quiescence and an attach
  envelope with every absent reason), every entry must be reachable (dead copy
  fails, with a short documented list of what no truthful offline producer can
  paint), and the closed vocabularies — all 71 journal kinds, every registry
  metric key and phase label — are pinned in both directions.
- **Scenario dashboard** ([tools/debug/scenarios.ts](../tools/debug/scenarios.ts) +
  [scenarios.html](../tools/debug/scenarios.html), served at `/`): every high-level
  behaviour as a named, diagrammed, measured card — happy paths (formation,
  owner-routed replication), fault paths (conflict, writes-racing-formation,
  dup/delay chaos, partition+heal, cut-mid-dial, backpressure) and meta rows
  (pinned wire invariants, a 100-seed sweep). Each card: a topology diagram
  (mesh, faults ≋, cuts ✂, writers), pass/fail, counted metrics with DELTAS vs
  the committed baseline (counts exact-compare — drift is always signal; wall-ms
  soft-compared, this box swings 2-3x), and a click-through that opens THAT run
  in the debugger (`/debug?scenario=<id>`). The registry is the data source; the
  page is a projection; baselines are pinned only by the CLI (`npm run
  scenarios`), never by rendering.
- **Contention is elections, not history:** `contested()` derives from the
  kernel's `lwwSkip` journal events — cells where an election actually REJECTED
  a candidate — so a single writer updating its own key reads as history, never
  as conflict (the fold originally counted any multi-candidate cell and painted
  a false contention wall). A genuinely concurrent race always produces at least
  one `lwwSkip` (at minimum where the winner's origin receives the loser), so
  nothing real is missed.
- **Live mode** ([tools/debug/serve.ts](../tools/debug/serve.ts)): the pull-spine made
  minimal — `/capture.json` rebuilds a truthful snapshot from a running in-process
  cluster ON REQUEST (no relay buffer with its own cadence to lie about, v2's
  10%-temporal-coverage bug class). The viewer polls; sim captures and live
  clusters are the same format in the same tool. `--live` runs **5 real TCP nodes**
  by default (M7's live-dash bar): the workload's key→writer rule is uncorrelated
  with the kernel's ring, so most writes enter at a non-owner and the KERNEL
  owner-forwards them — the cid write-route timeline (issued → forwarded →
  sequenced → applied at every node) lights up on real traffic. Measured on a
  fresh 5-node run: 44 route rows, 25 owner-forwarded writes, converged,
  replay-verified. `--contend` posts random-origin writes to a shared key set: it
  demos real LWW elections in the pre-genesis open window, after which the pipeline
  serializes even a deliberately conflicting workload through one sequencer — which
  is the M3 story on one screen.
- **The DIAG channel + attach mode** (M7 — [kernel/diag.ts](../kernel/diag.ts),
  [tools/debug/attach.ts](../tools/debug/attach.ts)): the same debugger, pointed at a
  REAL multi-process cluster. A debug client opens a normal link, HELLOs with `r:2`
  + a bearer token from the node's `diag.allow` allowlist, and latches into a
  session that is **structurally outside membership** — never in `byUuid` (a spoofed
  uuid cannot evict a real member), never admitted (invisible to genesis, suspicion,
  heartbeats, anti-entropy), never in the client set (zero per-record cost while
  attached). Pulls are cursor-chunked (journal / logs / node fold / state), so a busy
  node stays servable where a monolithic pull would frame-overflow into a dial loop.
  The wire says only `denied`; the TYPED reason (`no-config` / `bad-token` /
  `malformed`) and the audit identity (the allowlist NAME, never the token) live in
  the journal. `--attach h:p,h:p` rebuilds `/capture.json` from fresh pulls per HTTP
  request; a node that will not answer becomes an `absent` row with a typed reason,
  never an invented node card.
- **The shrinker** ([sim/shrink.ts](../sim/shrink.ts)): a failing seed's capture is
  joined by a MINIMAL one. Every schedule is a list of literal `Step`s and every
  build-time rng draw runs unconditionally, so removing a step cannot shift another
  step's randomness — determinism is self-enforcing rather than bookkept. The oracle
  is the first failure's CLASS (monitor name / named end-check / normalized crash),
  never its detail, and the artifact carries the original and minimal failure lines
  side by side so a shrink that landed on a different bug is visible rather than
  hidden. The final run is frozen AT the violating event, so the capture opens there
  by construction — time-travel needs no scrubber machinery. Measured on the M7
  acceptance demo: **40 steps → 1**, in 6 candidate runs, replay-verified.
- **The honesty promotion gate** ([tools/debug/honesty.test.ts](../tools/debug/honesty.test.ts)):
  plan §3.6 made executable. Empty-but-valid REAL-PRODUCER captures are folded and
  deep-equal-pinned (any field a fold learns to invent breaks it); every string leaf
  every fold emits must trace to a capture fact, a closed enum, or a composite
  identity whose every PART traces; `verifyReplay`'s prose is the one carve-out,
  pinned by template and exercised by a deliberately-truncated fixture so it can
  never go dormant; an absent row must change the header and nothing else; and the
  viewer is pinned at source to exactly one model import with no local fold
  redefinition (v2's dual-language drift bug, made structurally impossible).

## Adversarially reviewed

Each milestone gets an adversarial multi-agent review after its suite goes green
(N lenses → dedup → two independent refuters per finding, confirmation requiring
survival). The pattern has paid for itself every time.

**M0/M1:** 21 findings, all fixed — a **dial-race write-loss window** (a write
flushed only on the link that then lost the one-link-per-pair dedup died with it;
fixed by replay-on-admit: the own-write log is the retransmit buffer), an
**uncaught lazy-decode FrameError** (one crc-valid hostile frame could crash the
node), **crc coverage extended over the header** (a verb flip re-dispatched
RECORDS as PING silently), a `__proto__` decode corruption, a sim zombie-link
race, shell socket/listener leaks, a bypassable purity lint, a tautological
monitor.

**M2:** the headline was a genuine critical — the propose path could double-vote,
committing **two views for one epoch** under an honest schedule (1,514 monitor
violations in the review's own repro); fixed by ballot identity
`(epoch, proposer, members-hash)` enforced at grant AND propose sites, now 0
violations. Widening the sweep to 5 nodes also surfaced a latent M1 self-echo
log-poisoning bug (seed 79), fixed with the never-ingest-own-origin invariant + a
log-monotone monitor.

**M3:** a 6-lens / 50-agent review returned 11 confirmed (2 critical), all fixed:
- **Cross-owner exactly-once (critical).** The cid-dedup window was per-node, so a
  retry after an ownership move hit a new owner with no memory of the cid and
  re-committed — resurrecting a stale value OVER a newer acknowledged write (a
  silent lost update the per-epoch single-writer monitor couldn't see). Fixed by
  making committed forwarded runs **broadcast their attempt identity**
  (FLAG_ATTEMPT: issuer + contiguous cids); replication feeds every node's dedup
  window and doubles as an ACK (a replicated record carrying our issuer clears the
  pending attempt — a lost WACK self-heals via the data path). A new
  **attempt-exactly-once** per-event monitor watches the whole class directly, at
  the re-committing event.
- **Unbounded decode recursion (critical).** A deeply-nested hostile value threw a
  RangeError — not a FrameError — escaping the frame net and crashing the node.
  Fixed with a symmetric MAX_DEPTH cap on encode, decode, and skip.
- **NACK storm (major).** A same-epoch `withheld` NACK re-forwarded instantly via
  settle→flush, spinning at line rate against a minority owner. Same-epoch NACKs
  now re-park onto the RETRY_TICKS clock; only a NACK revealing a newer view (fresh
  routing state) re-drives immediately.
- **Spoofable ACK/NACK (major).** Any admitted link could clear or re-drive another
  node's route with a well-formed control frame. ACK/NACK are now bound to the
  **owner of record** (the forward target).
- Plus: relay ACKs re-batched (one WACK in → one WACK out, not n frames + n allocs),
  a view-learned member whose dial chain gave up is now revived (was parked forever,
  stranding attempts owner-routed to it), dedup lanes bounded by MAX_ISSUERS, the
  drain no-ops when nothing is parked (a `#queued` counter), per-event monitor
  cursors keyed to the node object (a sim restart rescans instead of blinding the
  monitor), and encodeControl/encodeRuns reuse module scratch instead of a fresh 4KB
  Writer per control frame. Seven more findings were refuted on inspection; four
  "contested" perf/observability notes were addressed anyway. The test count went
  110 → 121; every fix has a mutation-killer pin.

**M4:** a 6-lens review over the whole durability arc returned 20 findings;
triaged inline, 13 confirmed and fixed, every fix pinned (158 → 166 tests):
- **Durable froze in name only (critical, four independent finders).** A batch
  in flight behind a persistFail still advanced the durable watermark on its
  late echo — false `confirm:'persisted'` evidence for rows past a real on-disk
  hole, with zero lying disks. persistFail now voids `#inflight` entirely; the
  shell's io-queue latches `#walFailed` so an honest EIO can never leave an
  interior hole for the hole-means-lie verdict to misread.
- **The boot record had no fsync — file or directory (critical).** The one
  record everything fences on (votedFor, the Lamport ceiling, the incarnation)
  could regress across a power crash: a double-vote and cross-life seq reuse in
  one bug. Now write-tmp + fsync + rename + directory-fsync; the WAL swap
  rename gets the same directory fsync (every swap was a correlated rename-lie
  without it), and its fd handoff is failure-ordered (no dangling-fd window).
- **The burned-epoch wedge (critical, repro'd).** A proposer that collected
  durable votes and vanished froze membership FOREVER — every proposal targeted
  view.epoch+1, which the vote-once rule made unwinnable (M4b's durable
  votedFor made the burn survive restarts). Proposals now ESCALATE past known
  burns (own spent vote + the `ve` a refusal carries) and voters grant any
  epoch above their committed view — one-view-per-epoch still rests on
  vote-once-per-epoch, sweep-verified.
- **condemn() kept the condemned dedup window (critical)** — a post-condemn
  retry was dup-ACKed with the stamp of a record existing nowhere (silent
  acknowledged loss). The window resets with the fold; retries degrade to
  at-least-once until replication re-feeds it.
- **Stale evidence across a peer's crash (major).** Confirm marks are monotone
  — right within one life, a lie across lives. A HELLO with a higher
  incarnation now FORGETS every mark that peer announced (probes wait for fresh
  digests; the frontier pins until the reborn re-announces).
- **Tombstone GC's seq-only straggler bound (major).** LWW is epoch-first: an
  in-flight lower-epoch/higher-seq record escaped any seq comparison. GC now
  releases only at FULL quiescence (every member at every lane's known tail, on
  crash-stable marks, digest-only lanes included).
- **Mixed durable/non-durable frontier (major).** Crash-stability is a property
  of the MARK'S OWNER: a peer that ever announced a p map reads at markD
  everywhere; a never-announced-p peer's crash is a total refold, so its
  volatile mark is sound.
- Plus: a clean `destroy()` now flushes queued WAL appends (committed writes
  were silently dropped on shutdown); shell `restore()` distinguishes interior
  corruption (a crc-valid row beyond the failure → the condemn verdict fires)
  from an honest tail tear; `snapshot()` builds every row before mutating any
  state and caps rows at 1024 records; monitor cursors key on the log ARRAY's
  identity (a same-tick append+compact was invisible to a length check); replay
  emits per-record journal events so the debugger's time-travel fold survives a
  restore. Honest residuals, stated where they live (kernel/log.ts): a fresh
  fold racing two teachers can resurrect a GC'd-removed cell (M6 state-transfer
  closes it); dead provenance lanes are immortal in streams/digests (bounded by
  restart count — M6 digest work); durable mode without heartbeats has no
  compaction clock, so log AND WAL bounds require membership.

**M5:** a 6-lens review over the whole `api/` layer returned 14 findings; the
verify pass (two adversarial skeptics per finding) confirmed 13, all fixed and
pinned (205 → 215 tests). The headline was a genuine **critical the panel split
on** — resolved by an empirical repro, not a vote:
- **Re-entrant fast-path write orphans the outer write (critical).** At epoch 0
  (the solo/forming-server operating mode), a local write mints no kernel cid, so
  the binding PREDICTS cids and settles positionally. A user tap that writes from
  inside the apply drains a re-entrant `issue()` INSIDE the outer one (the
  substrate contract); it re-sampled the SAME predicted cid and clobbered the
  outer's single-slot collector + `#pending` key, so the outer write's promise
  never resolved — flush-on-return HUNG and `cluster.writes` stuck 'pending'
  (and a sibling case mis-rejected the trailing records 'superseded'). One refuter
  argued `data`'s `transact` serializes the writes; a 3-line repro showed the
  `_pending` drain runs INSIDE the outer apply, before the outer settle — the bug
  is real. Fixed with a STACK of per-call collectors + settling OWN promise refs
  (not colliding map keys).
- **Server-local methods skipped flush-on-return and returned a live alias
  (major, two findings).** The server-local dispatch used a no-op flush and blind-
  awaited the handler (collapsing thenable proxies), so local and wire invocation
  of one handler gave opposite durability, and `read()` handed back a mutable
  alias of committed kernel state. Both now route through `host.invokeLocal` — the
  same ALS flush + non-blind-await + clone-on-proxy-return as a wire CALL.
- **`'unreachable'` sentinel collision (major).** A handler throwing the exact
  string was misread as the kernel's no-primary failure — the call hung to timeout
  then re-executed on failover. The result effect now carries an unforgeable
  `local` channel bit; a wire reply is never mistaken for a pre-dispatch failure.
- **The dual-mode handle opened a subscription on introspection (major).**
  `String(h)`, `JSON.stringify`, an `in`-check, a symbol access all hit the get
  trap and leaked a client+server subscription. Coercion hooks and symbols are now
  passive (a marker, never a SUB); only a genuine reactive read opens the stream.
- **Subscription lifecycle races (major, two findings).** A SUB's `#subs` entry
  was registered AFTER the flush-on-return await, so an UNSUB or a link death
  during that window was lost, leaking a live server stream. The entry now
  registers up front with a cancelled flag the deferred open checks. And a live
  sub over a DERIVED (operator) proxy died after GC — the stream pinned only the
  leaf sink, not the operator chain; the entry now retains the live proxy.
- Plus: `write()` captured + cleared its timeout timer (a bare `setTimeout` leaked
  one timer + reject closure per write on the hot path) and normalizes async kernel
  rejections ('superseded'/'dropped'/'destroyed') into typed `WriteReject`s; the
  illegal `data[value] = x` root hatch now throws loudly AND heals the proxy back
  to the confirmed fold on a microtask (data sets the root before the sink can
  refuse it). Every fix has a mutation-killer pin; one finding was refuted (the
  clone-free read alias is `data`'s inherent shared-mutable model, reachable via
  the primary `data.k` read path too — not specific to the method surface).

## How this is better than v2 — measured, per dimension

**Testing.** v2 validated ALL protocol behaviour over real sockets + real timers:
a permanently-red 246/249 baseline on the only machine that ran it, 29 bare
`sleep()`s in one test file, a ~1/8 flake ticketed as possibly-a-real-bug, one
frozen soak seed, minutes of serial wall-clock. v3 M0: **30/30 green in ~5s**, the
protocol tier explores **1,300 distinct seeded trajectories per full run** (300 in
`npm test`, 1000 in the CLI), negative assertions are exact quiescence queries, and
the determinism canary (same seed → byte-identical state-hash trace) turns "flaky"
from a verdict into a class of bug that cannot ship. The Tier-3 real-socket tier is
3 tests, because that's all the shell needs.

**Robustness.** The write path is a function (`step({kind:'write'})` → ingest →
LWW → effects): v2's seven re-entrancy guard flags and two side-channel slots — one
of which shipped a cluster-wide silent lost-write — are structurally impossible, not
carefully avoided. Frames carry a crc32c over header AND body (v2 had zero
integrity protection — a flipped epoch byte was silently believed). Identity
precedes admission and is enforced (records before HELLO close the link); the dial
race collapses deterministically to one link per pair with no coordination frame
(v2 needed shadows, a WeakSet, idempotent-identify guards, and still couldn't
retrofit socket dedup). Loss HEALS: per-origin logs are the retransmit buffer,
digests exchange on every admit and after backpressure sheds, and live records
flow only on synced links so a suffix can never be leapfrogged into fake
duplicates. Every buffer is bounded at birth with journal-visible overflow. The
sweeps earned their keep repeatedly DURING the build: they caught the
Lamport-vs-contiguity collision, a non-FIFO sim-link modelling error, and — at
236/1000 seeds red — the live-write-leapfrogs-the-suffix ordering hole in the
first AE draft, each within seconds of being written. v2 found bugs of this class
one flaky wall-clock test at a time, months apart.

**Simplicity.** The M0 kernel is ~1,100 lines across 6 files, each owning one
domain; replication state is explicit fields on one class (v2: a 1604-line closure
with ~20 shared mutable variables that decomposition couldn't crack). One
bounds-checked Cursor replaces ~12 hand-inlined varint loops (two of which shipped
silent-truncation bugs in v2). One journal replaces five uncoordinated diagnostic
channels. Concept count so far: record, stream watermark, LWW cell, link, journal —
five, against a budget of 25 (v2's glossary: 214).

**Performance.** Perf gates are deterministic-first: bytes-per-record pinned
EXACTLY (73B canonical — a wire regression fails on any machine identically),
frames-per-burst counted exactly (one per peer per synchronous batch), lazy-scan <
full-decode asserted as an interleaved same-process ratio (the only pattern that
survived v2's WSL2 2-3x noise), and the kernel-vs-strawman step tax is a tracked
ratio (currently within 6x of the irreducible work, with the state-hash mirror —
the sim's oracle — as the known dominant term). Backpressure exists from commit
one: `write()===false` → pause → bounded queue → drain (v2 ignored every
socket.write return and buffered unboundedly). Encode-once: the streaming Outbox
back-patches one preallocated buffer — no per-frame Writer, no double sizing pass.

**Debug tooling.** The journal vocabulary existed BEFORE the layers that emit into
it (v2 bolted five channels on afterwards). Every drop, dedup, LWW loss, backpressure
transition, redial, and give-up is a typed, cursor-readable event with a surfaced
overflow counter. The sim's failure report IS a debug artifact: seed + violating
monitor + event index. Capture/replay/time-travel get their substrate for free
because state is a deterministic fold of the journal'd inputs — M7 spent that
substrate on the shrinker (a failing seed's capture is joined by a minimal one,
frozen at the violating event) and on the DIAG channel (the same folds, pulled off
a real multi-process cluster over the wire).

## What this deliberately does not have yet (stated, not implied)

- **Anti-entropy: event-driven triggers + the periodic floor.** Digests fire on
  admit and drain-after-overflow (every TCP-real loss mode), AND ride every
  heartbeat as the plan's §5 periodic floor — one reciprocal digest per tick from
  the PING side heals loss that NO event announces (transport bugs, future
  non-TCP shells; the sim test injects exactly that). Heartbeats also REVIVE
  given-up dial targets (`JK.revive`), so give-up is a cool-down, never
  permanent parking. Both are heartbeat-gated: heartbeats off (`heartbeatMs: 0` in the kernel's
  NodeOpts, `heartbeat: { ms: 0 }` at the api — the sim sweep mode) keeps
  trajectories quiescent and byte-identical. There is deliberately
  NO per-frame drop fault in the sim: TCP cannot drop mid-stream on a live link,
  and modelling it would demand interior-gap healing no real shell needs.
- **M2 membership is LIVE** (kernel/membership.ts): committed views with
  joint-consensus ballots (majority of BOTH old and new sets; at most one view
  per epoch — a per-event sim monitor, not a hope). Ballot identity survived its
  own adversarial review: a vote is (epoch, proposer, members-hash), enforced at
  the grant site AND the propose site (the review's critical: proposing once
  self-voted a vote already granted elsewhere — two views committed for one
  epoch under an honest schedule; the review's own deterministic repro now runs
  0 violations), re-grants to the same proposer are idempotent (a lost VOTE
  frame heals on re-offer instead of burning the epoch), aged-out proposals
  release the epoch, and every proposal path runs single-proposer discipline
  (lowest live member; JOINs relay one hop). Suspicion → eviction through the
  real propose path (held while a dial chain is still trying — give-up ends the
  hold; BOTH sides run chains now, so acceptor-side blips hold too), the CP
  write-gate (minority buffers into ONE bounded drop-oldest queue, flushes at
  the then-current epoch), the epoch-staleness contract (targeted VIEW pull,
  bounded retries, ALARMED release — never a silent wedge), view propagation by
  install-time FLOOD + view-on-admit (a detached evictee learns its fate from
  ANY member), reachability-gated re-joins (a proposer never re-admits a joiner
  it cannot reach — a persistent asymmetric cut stabilizes as CP read-only
  instead of churning epochs), membership frames fully shape-validated (a
  crc-valid garbage VIEW once crashed the node), and boot modes (a restored
  node is read-only until a live peer confirms its view — or, full-cluster
  restart, the lowest restored member self-ballots the restored view). Epoch 0
  is the OPEN genesis — exactly the M0/M1 behaviour until the first view
  commits — and everything membership does rides the heartbeat clock, so
  heartbeats-off (`heartbeatMs: 0`) sweeps never enter it. The data plane stays open by design:
  membership gates COMMITS and majority math, never replication — an evicted
  node still converges, its stale-epoch stamps just lose LWW. v2's V1d
  divergence class is a sim MUTATION test: a deliberately-broken self-fencing
  build diverges and the harness catches it; the real kernel runs the same
  trajectory green.
- **The sweeps kept earning it during M2:** widening to 5-node topologies caught
  a LATENT M1 bug (seed 79) — a digest-snapshot race echoed a node's own
  records back, self-ingest passed the high-water (local writes never advanced
  the own-stream watermark), and the resulting non-ascending log silently broke
  the AE suffix walk, stranding one record forever. Fixed with the missing
  invariant (a node never ingests its own origin) + a per-event log-monotone
  monitor so the whole class now fails at the poisoning event. 2,500 seeds
  across 3/4/5-node topologies green.
- **M3 the write pipeline is LIVE** (kernel/write.ts + kernel/ring.ts): every
  record enters through ONE ingress — source local (a 'write' event mints an
  Attempt {cid, attemptEpoch, issuer} and commits here or FORWARDS to the ring
  owner), forwarded (the owner cid-dedups then VALIDATES: owns-at-my-epoch +
  attemptEpoch === my epoch + gate open, else a typed WNACK {not-owner |
  stale-epoch | withheld, ce} — and, for a CLIENT's relayed record, the relay
  runs the server's seams.validation first: a refusal is the TERMINAL
  {invalid, m: reason}, 2026-09-05), inbound (M1's replication ingest, moved
  verbatim), replay (the M4 seam, named now). The ring is a pure function of
  the committed view (two parallel typed arrays, allocation-free `ownerOf`), so
  one-view-per-epoch (M2's monitor) makes single-writer-per-(partition, epoch)
  STRUCTURAL — and that is now a per-event sim monitor of its own. All four of
  v2's DECISIONS-AA conflict sources run as named fault schedules
  (sim/write.test.ts): the never-drop fallback is DELETED (lost-ACK retries
  dedup by cid at the owner and the duplicate ACK re-carries the ORIGINAL
  commit coordinates — exactly-once at the commit site), un-validated
  commitForwarded is inverted (owner validation, with the install window also
  squeezed shut structurally: FIFO links + install-flood + view-on-admit + the
  minority gate — four independent guards a five-construction fault hunt could
  not beat), the flush re-stamp is unrepresentable (parked attempts re-resolve
  OWNERSHIP at the flush boundary and forward; attemptEpoch is re-stamped ONLY
  at issuer/flush boundaries, and a purity-suite lint pins node.commit's sole
  caller), and the restore-boot collision dies in M2's rejoining read-only mode
  (its parked writes owner-route at the merged epoch). The AA#3 mutant — a
  v2-shaped local flush — is CAUGHT by the single-writer monitor (the V1d
  pattern applied to M3). The client relay rule is in the kernel now:
  attemptEpoch 0 marks a client attempt; the first server re-stamps at relay
  time, keeps the CLIENT as the cid-dedup issuer, and routes the ACK back on
  the arriving link. The ONE bounded pending queue (drop-oldest, surfaced)
  replaced M2's buffer — gate-closed, owner-unreachable, NACKed, and
  awaiting-ACK attempts are all the same parked work, re-driven at flush
  boundaries and the heartbeat retry clock. Epoch 0 remains the OPEN fast path:
  byte-identical M0/M1 trajectories (the 3-node sweep produces the exact same
  237,451 events as pre-M3), zero attempt machinery below genesis (a counted
  perf pin). Hot-partition ceiling measured on this box: **~125-134k forwarded
  records/s through one owner** (kernel/write.perf.ts prints it; WSL2 swings
  2-3x — the counted invariants are the durable claims: one WRITE frame per
  batch per owner, one WACK per run).
- **M4b the durability core is LIVE** (the storage seam + boot record; confirm
  and compaction are M4c/M4d): storage is an EFFECT/EVENT pair — the kernel
  emits `persist(batch, bytes, prev)` and `boot(record)`, the env echoes
  `persisted`/`persistFail` — so purity and seeded determinism survive intact,
  and durability is an EXPLICIT MODE (`durable: false` default keeps every
  pre-M4 trajectory byte-identical; the 3-node sweep is still the exact same
  237,451 events). The WAL row IS the wire frame (the same Framer reads a
  socket and the file); restore replays rows through the SAME single ingress
  (source=replay) with original provenance, before the network exists. The
  durable-mode chaos sweep (150×3 + 150×5 seeds: torn tails, fsync lies, dead
  disks, random mid-workload restarts) caught THREE real design flaws while
  this slice was built, each now structural: (1) **interior WAL loss is
  unhealable by suffix anti-entropy** (a lying disk drops middle batches;
  Lamport gaps make the hole invisible to seqs) — every row now carries a
  per-origin CHAIN LINK, and since honest crashes tear TAILS (the shell's
  ordered io-queue and the sim's FIFO fsync clock make resolution order =
  append order), a hole PROVES the disk lied: replay CONDEMNS the restore
  (M4e hardening — the fold resets, the WAL swaps clean, the cluster
  re-teaches; a liar's prefix kept alive resurrected removed cells whose
  fences had been compacted away on this disk's own durable claims); (2) **a stale clock floor let a reborn node re-issue spent
  seqs** (silent loss both directions) — the boot record now stores a Lamport
  CEILING (a lease, re-persisted every LAMPORT_LEASE stamps) and a restore
  resumes AT the ceiling; (3) **one log cannot serve two lives** (after the
  ceiling jump, a lost record of your own could never re-enter below the
  watermark) — a reborn node stamps under a fresh PROVENANCE LANE
  (`uuid~incarnation`; first lives keep the bare uuid, so the wire is
  unchanged), making the previous life an immutable foreign stream that heals
  by ordinary suffix AE — the plan's "incarnation fences dead-origin debris",
  made concrete. persistFail is TERMINAL for the WAL (the fsyncgate policy:
  alarm + freeze durable; replication untouched). The boot record carries
  {view, ceiling, incarnation, votedFor} atomically — a crash inside one
  ballot round can no longer double-vote (the M2 debt, closed with a pin),
  and the sim's `restart(uuid)` rebuilds a node from nothing but its store.
- **M2 debts (stated):** ~~votedFor/committed-view durability~~ — closed by
  M4b (the boot record; pinned). Suspicion still keys off link liveness, not
  PONG timeouts (a hung-but-connected process needs a real-time fault vocabulary — deferred past M4, tracked);
  genesis requires one full formation of the configured hosts. ~~A healed
  evictee may flush at its stale epoch~~ — closed by M3: the flush re-resolves
  ownership and the owner validates attemptEpoch (typed NACK, re-stamp at the
  issuer boundary, retry).
- **M3 debts (stated):** owner-side dedup is an EXACT bounded window
  (DEDUP_KEEP=1024 committed cids per issuer with original coordinates), not
  the plan's high-water + out-of-order set — per-owner cid streams have
  legitimate permanent gaps (cids interleave across partitions and ownership
  moves between epochs), so a high-water test would FALSELY eat first
  deliveries. Attempt identity now rides committed records so the window is fed
  by replication cluster-wide (a retry after an ownership move dedups instead of
  re-committing); the remaining residual is narrow — a retry that outraces the
  ORIGINAL commit's replication to the new owner re-commits as a same-value
  higher-stamp LWW supersede (harmless for idempotent records; M4's confirm
  ladder closes it, since a confirmed write implies the new owner holds the
  stream, and M5's non-idempotent methods will size the window against the retry
  horizon). Dedup LANES themselves are bounded (MAX_ISSUERS=1024, oldest-
  evicted, journal-surfaced) so a client churn can't grow kernel memory
  forever. ~~The issuer cid counter is volatile~~ — the incarnation now rides
  the durable boot record (M4b), so the uuid~inc issuer lane is fresh across
  real restarts by construction. Pending overflow drops the OLDEST attempt
  (journal-surfaced) — under sustained gate-closed writes beyond
  MAX_PENDING=1024 that is real, counted loss.
- **M5 — the public api — is COMPLETE** (M5a composer + M5b clients + M5c
  methods + M5d cluster/scenarios/demo; adversarial review pending) (api/):
  `await fero(name, opts)` → `{data, methods, cluster, destroy}` over `$()`
  (V4-2 widened the surface to `{name, data, methods, cluster, snapshot, destroy}`)
  proxies, sliced (like M4) into four landable increments: **M5a** composer +
  data binding + cid-overlay → **M5b** the client role (below) → **M5c** methods
  (CALL/SUB verbs, sink.invoke with handlers hosted in the impure api layer,
  tagged Handles + failover policies, flush-on-return) → **M5d** cluster
  end-to-end + the scenario library over the public surface + the two-terminal
  demo + the M5 adversarial review. What M5a establishes:
  - **The substrate contract is settled by probe, not promise** (plan §10's
    go/no-go): `data`'s bare-verb sinks are clone-free with synchronous detach;
    `[view].res` is the record-apply ingress; echoes come back verb-REWRITTEN
    (update→insert) and re-entrant user writes drain INSIDE an apply call — all
    pinned facts (api/substrate.ts banner), consumed through ONE wrapper seam.
  - **Two surfaces, no flag family**: kernel state IS the confirmed fold;
    the proxy = confirmed + the cid-keyed pending overlay (read-your-writes).
    Echo suppression is match-and-consume of one expected echo per apply; the
    overlay needs no value bookkeeping (the beneath is always derivable from
    kernel state — revert/bounce re-reads it). *(Superseded by V4-7: ONE
    surface — the overlay is deleted, the proxy IS the fold, a write shows
    when it commits.)*
  - **The write-route join**: Applied now carries the attempt identity
    (iss, cid) on every path that knows one (commit/inbound/replay — pinned),
    so the api resolves its own writes off the ONE apply stream; the cross-epoch
    LWW-loss race resolves from the dedup window's original coordinates
    (writes.committed probe) instead of hanging.
  - **One ingest** for assignment sugar and `methods.update/insert/remove`
    ({confirm, timeout} against the M4c ladder, WriteResolve/WriteReject
    unions) — so seams.validation covers both by construction (v2's OQ6) —
    and, since 2026-09-05, the writes a server RELAYS for its clients
    (DECISIONS V4-4): the relay is an issuer boundary and validates like one;
    a refusal is the terminal WNACK `invalid` and the client sees the reason.
    Since 2026-09-06 (V4-5) `methods:` is the door: declaring hosted methods
    makes clients change data ONLY through them ('methods-only' refuses every
    relayed plain write — since V4-7 nothing shows on the client meanwhile);
    spokes are views — they never teach a server and
    resync to the cluster's truth when their feeder's digest is below theirs.
  - ~~Capture-path overlay entries whose attempt the kernel drops at
    MAX_PENDING overflow released only on the cell's next apply~~ — closed by
    M5b: onAck feeds the dedup window (WACK coordinates ARE original commit
    coordinates), and Bind sweeps on every droppedPending change — cleared
    entries resolve from the window, dropped ones reject visibly in
    cluster.writes (V4-7: nothing to revert — nothing showed).
    Still tracked: the cluster fold rides a post-step hook (first-class
    membership effect is the M5d decision); user methods stash until M5c.
- **M5b — the CLIENT role — is LIVE**: `fero(name, {hosts})` with no `listen`
  is a SPOKE — a kernel node that folds the same replication stream as every
  member but is invisible to membership. The shape:
  - **Role on the wire, one byte**: HELLO gains `r:1`. Servers exclude client
    links from genesis (count, sweep, and the lowest-uuid race — pinned), never
    suspect them, and a client node runs none of the member machinery (no
    propose/vote/JOIN-knock; stale-pulls and settle stay live).
  - **The single-feeder rule**: a client digests exactly ONE server (its
    PRIMARY — first admitted; re-elected on linkDown with immediate repark +
    re-relay). Non-primary digests are consumed for confirm evidence but never
    answered, so `synced` never rises elsewhere — per-origin ordering holds
    because a spoke has ONE feeder by construction, and failover re-enters
    through the same digest→suffix-ship door as every other heal.
  - **The spoke feed**: servers tap-forward fresh INBOUND records to synced
    client links (commit broadcasts already covered own-origin records), so a
    spoke hears every lane live through its primary instead of at AE cadence —
    attempt identity intact (the write-route join reads it). Zero cost to members:
    one set-size check per record when no clients are connected.
  - **Client writes are the plan's §5 contract verbatim**: ae=0 attempts (the
    client marker, regardless of the view the client knows) relayed by the
    primary, which re-stamps at arrival and owns re-resolution; retransmit on
    the tick clock; owner-side cid dedup absorbs every ambiguity — the sim
    pins lost-WACK, lost-WRITE, and feeder-death-mid-flight as exactly-once.
  - Validation: 193 tests (5 kernel client pins, 4 sim spoke suites incl. a
    30-seed in-suite mini-sweep, Tier-3 composer failover), the 150-seed
    client-chaos sweep (per-pair delay/dup faults, feeder partitions, severed
    relay-hop frames — 1.86M events, spokes included in convergence), and the
    epoch-0 sweep still byte-identical (the role is inert when off).
  - ~~A spoke's confirm probes see only its primary's digest evidence~~ —
    closed by M5c: confirm-over-RPC (the system plane) proves a spoke's
    guarantee AT its primary, which holds the full member evidence. Durable
    clients (offline-first) remain refused loudly at fero() time — M6.
- **M5c — the METHOD PLANE — is LIVE**: RPC + live subscriptions over five new
  control verbs (CALL/RESULT/SUB/UNSUB/SUBREC), with the kernel ROUTING and the
  api HOSTING (purity: a user handler is arbitrary async code — it surfaces as
  the `invoke` effect and answers via `reply`/`subOut` events; the kernel never
  runs it and tracks no rpc state). The shape:
  - **Return-type dispatch, both ends** (plan §9): the host probes the handler's
    return with the view symbol (a ViewProxy is subscribable, a value is a
    value); the caller's dual-mode HANDLE picks consumption by touch — `await`
    is a one-shot CALL, any reactive touch opens the live subscription into a
    local mirror proxy (then/open/close/mode are the reserved handle surface).
    The never-blind-await lesson is pinned: a ViewProxy is THENABLE, so awaiting
    a handler result would collapse the live view to one frozen frame — the
    host probes before awaiting (and an async handler returning a proxy still
    collapses by promise adoption — return live views from sync handlers).
  - **flush-on-return is BUILT** (plan §9, not documented-and-deferred): an
    AsyncLocalStorage collector attributes every write a handler issues (across
    awaits) to its invocation; the reply awaits them all at 'committed', and
    `ctx.flush()` is the mid-body barrier — pinned by a Tier-3 test that holds
    a reply hostage behind a closed write-gate.
  - **Failover policies close v2's OQ2**: live handles RE-SUBSCRIBE on the new
    primary (same id — server subs are per-link; the fresh initial snapshot
    root-replaces the mirror); 'unreachable' (never-shipped ⇒ never-executed)
    calls re-dispatch safely for everyone; shipped-and-lost calls fail fast
    unless {retry: true} (re-execution is only safe when declared idempotent —
    method invocations are NOT cid-deduped; only the writes they issue are).
  - **The client methods namespace is OPEN** (a spoke cannot know its servers'
    method names): any name yields a handle; unknown names reject typed from
    the server. Server-local calls are one-shot invokes (v2's localMethods
    rule) — live local projections are `data` + operators directly.
  - Stated limitations: SUBREC bodies ride the control value codec (per-delta
    clone + value encode — the perf tripwire bounds it); 'move' records
    (windowed sorts) do not stream — subscribe to the source and sort on the
    client proxy; async handlers returning proxies collapse to snapshots.
  - Validation: 201 tests (3 kernel routing pins, 5 Tier-3 method suites incl.
    flush-hostage and failover re-subscribe), 18 perf gates, epoch-0 sweep
    byte-identical, 17/17 scenarios zero drift.
- **M5d — cluster end-to-end + the public scenario library + the demo**:
  - **cluster.writes is the bounded confirm ring** (plan §9): the last
    WRITES_KEEP=64 write outcomes as reactive rows {key, state: pending →
    committed | rejected, origin/seq/epoch/cid, reason}. Plan Q4 is DECIDED:
    pending rows are visible in cluster.writes and never marked inside `data`
    itself — observability is a cluster concern; the data surface stays pure
    value. The ring lives in the binding; the composer folds it on the same
    post-step hook as the view (one integer compare per event when quiet).
  - **The fold decision (deferred from M5a) is DECIDED**: the post-step hook +
    journal cursor IS the mechanism for cluster reactivity — a first-class
    membership sink effect would duplicate journal facts for one consumer.
    Revisit only if M7's diagnostics work wants membership effects for replay.
  - **The scenario library runs against the PUBLIC surface**
    (tests/api-scenarios.test.ts): v2's chaos vocabulary — 5-node formation +
    concurrent-writer convergence, kill/restart-from-WAL through
    fero(name,{dir}), the FULL-CLUSTER kill + restore-from-WALs-only (the M4e
    proof, public edition), and cluster.writes observability — no kernel
    reach-through in any scenario body. Partition/heal stays sim-only by
    design (real-TCP partition injection tests the harness, not fero).
  - **The two-terminal demo** is rung 02 of the example series
    (examples/02-server-client — `node server.ts` / `node client.ts`, or
    `npm run demo` / `npm run demo:watch`; the series index is
    examples/README.md): a server rewriting whole inventory rows by
    plain assignment, a client re-rendering through one tap AND writing
    back as FACT rows (a client's assignment rides a WRITE frame to its server, is
    stamped there, and echoes to every watcher); kill and restart the server
    and the watcher redials the new port and its taps resume (a memory-only
    restart re-seeds and the watcher resyncs to it — its earlier sales go;
    `dir` is rung 12). Since V4-2 the demo needs
    ZERO addresses/identities: the server is a server because it declares a
    `data:` seed, the watcher is bare fero(name) — and since V4-3 both meet
    through the box's directory: the server binds a FREE port and registers
    it with `#directory`, the watcher looks the name up live (no hashing; a
    second `serve` in a third terminal joins the first as a cluster).
- **V4-3 — the per-box directory** ([docs/DESIGN-DIRECTORY.md](DESIGN-DIRECTORY.md),
  DECISIONS V4-3): the name-derived port is gone. `#directory` is a SYSTEM
  resource (the `#` prefix is reserved — fero() refuses it for users) at one
  well-known loopback rendezvous, `127.0.0.1:3376` ("FERO" on a keypad, below
  the ephemeral range; `FERO_RENDEZVOUS` env / `rendezvous:` config, `false`
  = no directory). The first server on the box to bind it hosts a soft-state
  registry `name → {uuid: listen}` on the method plane (never a log, never a
  WAL); every dialable instance opens a `#directory` client: servers bind a
  free port (`127.0.0.1:0`, the shell publishes the real address to the
  kernel before start) and `register`, everyone opens `lookup(name)` as a
  LIVE subscription whose folded addresses feed the kernel's new `discover`
  event (static ∪ dynamic hosts, cached; forgotten targets park, never
  closed). Entries die with their registrant's link; a host's death makes
  the surviving servers race for the port and the lookups re-subscribe —
  registrants re-register on every primary change. Measured before/after:
  N bare servers of one name now form a view with no addresses and no uuid
  pins (the genesis coin-flip is closed), a bare client finds explicit-listen
  servers, two names never collide, a NEW joiner after the host died still
  finds the survivors, and a non-fero squatter on the port is survived.
  `cluster.me` carries the effective `hosts` and `rendezvous: {addr, hosting,
  up, error?}`; the diagnostics seam exposes the directory nodes. Precedence:
  `rendezvous:` config > `FERO_RENDEZVOUS` env (an address, or `off`; it sets
  the PROCESS DEFAULT and never overrides an explicit key) > the constant.
  Trust boundary, stated: the directory is as unauthenticated as the peer
  plane — loopback IS the boundary; any local process can register any name
  (it could equally dial the resource and HELLO with that name); a per-caller
  cap bounds a runaway, nothing authenticates. A user resource may not listen
  on a rendezvous socket under any spelling (`0.0.0.0:3376`, `localhost:3376`
  …), and a name-rejected target is revived at heartbeat cadence, so a squat
  is a bounded nuisance, not a strand. The battery runs with the directory OFF
  (every non-directory suite pins `FERO_RENDEZVOUS ??= 'off'` at import, so a
  single-file run never meets a live box directory); api/directory.test.ts
  opts in with a free rendezvous port per test. The post-landing adversarial
  panel and its fixes: DESIGN-DIRECTORY §10.
- **M8 — hardening is LIVE** (panel-designed like M6/M7: 2 candidates + a skeptic
  judge per open question + a plan-coverage critic; the alloc judge ran its OWN V8
  probes to adjudicate a factual dispute between candidates). What landed:
  - **Allocation verification with teeth** (kernel/alloc.perf.ts, `npm run
    perf:alloc`, and inside the default perf gate): the panel's adjudicated finding
    is that a naked gc-fenced heap delta is UNSOUND for exactly the failures it
    exists to catch — scavenges EAT the delta, so the signal SHRINKS as a
    regression grows and min-of-k selects the most-truncated window. The sound
    instrument is a conjunct: delta-≤-slack AND `gcEvents === 0` (GC-event physics:
    a loop that allocates nothing can never scavenge — categorical at every
    regression magnitude, and immune to WSL2 CPU noise). Three claim classes
    (DECISIONS V3-21): zero-GARBAGE ring lookups, zero-RETENTION steady cycles
    (duplicate-absorb, Outbox, issuer leg), retention-BUDGETS on the fresh path
    (retention IS the product — the honest claim is ≤512 B/record, batch-
    independent). The suite's mutation control (D6) proves the instrument can see.
    **Its first run found a real bug**: ring.holdersOf discarded its scratch's
    backing store every call (~7 scavenges/100k calls) — fixed to index-cursor
    writes (0 events), gate Z4 fencing it forever.
  - **The persisted absolute tier** (tools/perf/: fixtures single-sourced with the
    perf siblings, a 9-row probe registry, a pure compare module, the pin CLI, and
    [BASELINE.md](../tools/perf/BASELINE.md) — the never-widen escape hatch written
    down). Counts (bytes-per-record 73, frames-per-burst 3, per-forward 1,
    per-owner-run 3) exact-compare on ANY machine; wall medians compare only on
    the runner FINGERPRINT that pinned them (host + OS + CPU + Node major), with
    `advisory` posture printing and only a `pinned` posture (refused on WSL/VM
    boxes) enforcing. A pin refuses on missing --runner/--reason, any erroring
    probe, an out-of-band baseline move, and a tolerance outside the validated
    10–50% cap (the bypass a candidate design left open). First pin: advisory,
    wsl2-devbox.
  - **Socket throughput, measured honestly** (tools/perf/probes.tcp.ts): ~62k
    records/s through the real TCP shell on this box — completion clocked by an
    onApply COUNTER (never the Lamport watermark, which is not a record count —
    a panel-caught trap), validity by JOURNAL physics (a tap counting
    dropOldest/aeShip: a mid-run shed that AE heals passes every end-state check
    while the median measures anti-entropy — so both must be zero or the run is a
    typed probe-error, never a number). Plus the digest-build gate (100 origin
    lanes, entry count exact) closing plan §7's last counted-invariant gap.
  - **The v2 referent, classified** (DECISIONS V3-20): v2's L2 write path is
    socket-coupled at construction — the plan's headless interleaved A/B is
    unconstructible against it, and against v2's bare L1 (array push + project,
    no dedup/LWW/provenance/watermarks) it is a category error: measured ~9× in
    v2's favor, which prices exactly the machinery v2's L1 does not do (v3's own
    strawman ratio, ~3×, is the tracked analogue). The real referent — both
    stacks over sockets — is specified beside the pinned-runner IDEAS entry.
  - **The ledgers + the recipes**: v3/DECISIONS.md (V3-1…V3-21 + carried v2
    rejections) and v3/IDEAS.md (every DESIGN-M6/M7 residual, the carried module
    debts, the Tier-3 descope, the CI provisioning entry) seeded; the
    cross-partition recipe and the availability posture written (above); the
    green-or-quarantined policy stated with its two sanctioned skip classes.
- **M7 — debug tooling, full is LIVE** (design record: [docs/DESIGN-M7.md](DESIGN-M7.md),
  panel-synthesized: 3 open questions × 2 independent candidate designs × 1 skeptic
  judge, every citation verified against the tree before synthesis). Most of plan §8
  had already been pulled forward — the journal spine (M0), the capture format, the
  typed model with time-travel + replay-verify, the full viewer, the scenario
  dashboard. M7 closed the five things that were genuinely absent:
  - **The DIAG wire channel + its allowlist** (kernel/diag.ts, verbs 23/24, JK
    68–70): the authenticated diagnostics plane plan §8 reserved from the first
    protocol byte, and — per plan §12 — the only auth v3.0 ships. The panel killed
    the obvious design: a monolithic whole-node pull frame-overflows on exactly the
    busy nodes you attach a debugger to, and the resulting FrameError → link drop →
    re-dial is a deterministic loop, so pulls are cursor-chunked instead. The
    session is a LINK STATE, not a peer: never in `byUuid` (so a diag client
    presenting a member's uuid cannot trip the dup-link keeper and evict it), never
    admitted, never in the client set. The HELLO path — the kernel's most
    safety-critical code — grew exactly one branch. The wire deny is one constant
    (`denied`) so an unauthenticated prober learns nothing, while the journal keeps
    the typed reason and the allowlist NAME; the token never rides the journal.
    Journal pulls are deliberately NOT journaled: journaling reads-of-the-journal at
    follow cadence evicts the very history being followed (a 1 Hz dash would eat a
    4096-row ring in minutes) — the audit anchor is the session latch plus its
    linkDown.
  - **Parity by construction:** `captureNode` is re-based onto the same `diagNode`
    fold the wire serves. One producer, two consumers — an in-process capture and a
    remote attach cannot drift, and a deepEqual pin backstops it anyway.
  - **The shrinker** (sim/shrink.ts) and the acceptance loop: chaos failure →
    minimal repro → the capture opens AT the violating event. Measured on the
    acceptance demo (a fence-blind log re-append mutant, the V1d precedent):
    **40 steps → 1 step in 6 candidate runs**, replay-verified, with the
    original and minimal failure lines side by side in the artifact so a shrink
    that wandered onto a different bug is visible rather than hidden. The repro
    block is standalone-replayable from DATA (`npm run shrink -- --replay`) — the
    fix-verification loop.
  - **The `[diagnostics]` handle** (api/diagnostics.ts): v2's Symbol-keyed idiom on
    v3's organs — capture / journal cursor / served / confirms / logSize / compact /
    drop. Nothing is stubbed: `observe`/`isolate`/`heal` are ABSENT rather than
    faked (the journal cursor and the public tap are the pull-spine answers; a TCP
    shell cannot hold a partition honestly). The review's shared defect is fixed
    here: `compact()` is size-gate-free (v2's drive-it-deterministically purpose)
    but REFUSES on an armed node — forcing a member-ranged frontier pass on a scoped
    holder could drop the only real copy, so the pin wins and says so.
  - **The 5-node live dash** and **the honesty promotion gate**: measured on a fresh
    `--live` run — 5 nodes, converged, 44 write-route rows, 25 owner-forwarded
    writes with acks, replay-verified. The gate makes plan §3.6 executable, and it
    caught a real derived-key case on its first run (it now verifies the DERIVATION
    of composite identities rather than blanket-allowing their shape).
  - Full battery after M7: **288/288 tests, 20/20 perf gates, 1000/1000 identity
    sweep at exactly 237,451 events** — every byte of the new surface is
    unreachable without an `r:2` HELLO or a DIAGQ arriving, so the frozen sweep is
    untouched, and the harness refactor the shrinker required is pinned by a
    200-seed golden against the frozen pre-split scenario.
- **M6 — scoped replication + aggregates** (design record: [docs/DESIGN-M6.md](DESIGN-M6.md),
  a three-design judge panel synthesis; landed as six slices, M6a-M6f):
  - **R-sets**: `replicas: N` config (explicit mode like durable/client — unset
    is R=∞ and every scoped branch is provably inert: the 1000-seed epoch-0
    sweep stayed byte-identical at exactly 237,451 events through all six
    slices). `ring.holdersOf` extends ownerOf — holder[0] IS the owner, so
    single-writer is untouched; a per-epoch memo makes the fan-out filter one
    Map.get per record.
  - **The scope machine** (kernel/scope.ts): held | acquiring | orphan per
    partition. Commits fan out to holders only; the inbound gate drops
    non-assigned records before the fence; orphans HARD-FREEZE (floors never
    advance — monitored expected-empty).
  - **The evidence plane**: per-(origin, partition) POSSESSION FLOORS
    ("contains-or-covers ≤ s") beside the untouched per-origin dedup fence;
    the DUAL FENCE splices lawful cross-link interiors; the no-interior-rows
    WAL discipline (splices reach disk only via the snapshot swap; a dirty
    ledger in the boot record keeps replay floors honest across crashes).
    HAVEQ/HAVEA carry attested marks (the DIGEST wire shape is untouched in
    both modes); scoped confirm counts W-of-the-R-set on attested marks only.
  - **The handover**: one-teacher ACQ/ACQDONE latches (stage → verify count →
    atomic fold → floors := the attested cut → staged live replays above it);
    five abort legs drop the buffer whole. The STATELESS shed re-evaluates
    fresh per arrival/install/tick — every current holder must attest
    coverage of every frozen lane; crash-safe both sides (H1 proven both
    legs); shedStall alarms at doubling cadence, shedWaitingOn names pinners.
  - **The gather** (api/fold.ts, v2 Q3 carried): whole-resource read() IS the
    download — stamped claims over held ∪ unshed-orphan scope, per-key LWW
    merge, PARKING + the coverage sweep. §9 holds end-to-end: holistic
    operators throw typed ScopedError (never a silent shard fold), `await
    data` routes through the gather, non-held keys answer via typed remote
    handles, ScopedError rehydrates typed across the wire.
  - **THE Q3A VERDICT: real, reproduced, closed** (sim/q3a.test.ts). The plan
    called it a "suspected real bug" — the mutation study (a v2-faithful
    owned-only root-replace gather in the identical harness) vanishes keys on
    60/60 {A,B}→{C,D} seeds; v3's parked union survives 1000/1000 seeds of
    the same windows (500 organic grows + 500 pin-flip double handovers, 5ms
    refresh slices through the acquisition window). The hunt also caught
    three real v3 projection bugs before they shipped: parent-tombstone
    ordering over live nested cells, explicit-undefined representability
    (tombstone-equivalent, pending the value-codec ticket), and one doomed
    cell aborting the whole projection transact (now per-cell isolated) —
    plus refresh serialization (a one-shot read racing a shed re-gather
    answered a mid-flight partial).
  - **Deferred with rationale** (the M6 residual ledger, for the review round
    and the next milestone): announcement-gated AE + scoped compaction
    un-pinning are COUPLED (ring-gated AE is provably safe while compaction
    is pinned — the H3 resurrection needs differently-compacted teachers);
    tombstone GC stays pinned when armed; the distributed decomposable folds
    (sum/max/avg facade) deferred by de-scoping rung 2 — holistic ops throw
    with the materialize-first hint instead; spokes mirror their primary's
    held shard (whole reads are gather-backed; subscription-scoped
    tap-forward is future work); explicit-undefined cells do not cross the
    gather; the live gather re-arms by install + paced re-poll (a push-based
    claim stream is a wire optimization).
  - **THE M6 ADVERSARIAL REVIEW ROUND** (6 find-lenses × 2 skeptics per
    finding, every verdict traced against the real code): 55 findings, **50
    confirmed**, 1 split, 4 rejected — every survivor fixed with a
    mutation-killer pin. The centerpiece fix is **the pp floor law**
    (DESIGN-M6 §7 addendum): the fast-path possession-floor advance's old
    license ("single-source ascending sub-stream delivery") was locally
    unverifiable and false in three confirmed-critical windows (mid-lane
    first arrivals minted held with a forged prefix claim; an AE re-admit
    race dropped the healing span at the dual fence; two senders serving one
    lane interleaved into the same forgery — each breaking exactly-R/P2/P3
    permanently). Every armed record now carries `pp`, its sender-stamped
    (origin, partition) predecessor (FLAG_PP, one varint per record; wire 0 =
    unknown, which FAILS CLOSED), and a floor advances only when it already
    covers the predecessor — locally-verifiable sub-stream contiguity, with
    the boot record now carrying a floor SEED the replay chain-rebuild
    advances from. Companion structural fixes: the shed bar re-based onto
    frozen lane TAILS (floors lawfully under-claim under pp — the old
    empty-floors husk drop destroyed epoch-0/bootDirty data with zero
    coverage proof); durable ACQDONE attestation gated on the snapshot
    swap's echo (`sealed` — an orphan can never shed against marks one crash
    erases); the boot record's held/orphan split (a restored orphan
    re-enters only through the latch, never a silent un-freeze); the install
    order fixed to VIEW-flood → rescope → boot-write; evidence-plane
    liveness closed (round-on-admit, marks-lag re-rounds, the orphan
    re-entry latch at equal floors, non-holder confirm probes with
    probe-local evidence); the armed fan-out's run-discontinuity frame
    rotation (a latent wire corruption on multi-record scoped batches); and
    the gather's coverage sweep re-based onto per-answer ATTESTATION sets
    (an acquiring or post-shed answerer can never attest absence) with
    departed-member claim reaping. Test honesty landed alongside: the scoped
    P2 oracle (`scopedConfirmedIntact`), engagement guards on the CHURN and
    Q3A sweeps, and monitor snapshot/vacuity fixes. Full battery after the
    round: **254/254 tests, 20/20 perf gates, 1000/1000 identity sweep at
    exactly 237,451 events** — the entire fix round is byte-invisible at
    R=∞.
- The plan's pre-M4 CHECKPOINT (the M2–M4 swamp guard) is
  [docs/CHECKPOINT.md](CHECKPOINT.md) — verdict: no overrun, ladder armed but not
  triggered, M4 sliced into five landable increments (M4a streams/watermarks →
  M4b storage seam + boot record → M4c confirm ladder → M4d log/compaction →
  M4e the restore proof), each closing named debts from the ledger — all five
  are now LIVE.
- **Verification status (per plan §7/§11), updated at M8:** the allocation claims
  ARE now counter-verified — kernel/alloc.perf.ts under --expose-gc (DECISIONS
  V3-21: zero-garbage ring lookups by GC-event physics, zero-retention steady
  cycles, fresh-path retention budgets; the suite's first run found and fixed a
  real holdersOf violation). Absolute medians + socket throughput ARE persisted —
  tools/perf/results/baseline.json (advisory posture on this box; see
  tools/perf/BASELINE.md for the runner-identity rules and the escape hatch). The
  replay-refold check has been live since the debug tool landed. Repo CI remains
  unprovisioned: no git remote exists, so workflows would be dead files — the
  provisioning entry is IDEAS P1, and the baseline machinery is ready to accept
  the pinned runner's numbers the day it exists.
- **M4d compaction is LIVE** (kernel/log.ts): the snapshot record supersedes
  the prefix — below the per-origin FRONTIER (every committed-view member
  provably past the cut on CRASH-STABLE marks: durable evidence in durable
  mode, applied marks otherwise — M4e's restore sweep proved applied marks
  compact away history a crashed lane still needs) each entry that is not its
  cell's current winner is dropped; winners
  survive as ordinary records with ORIGINAL provenance, so catch-up needs zero
  new machinery and the two plan properties hold as property tests
  (replay-from-0 ≡ live; compacted catch-up ≡ uncompacted). A lagging member
  PINS compaction — memory is spent exactly where a peer still needs history.
  Tombstone GC releases a remove's stamp once no straggler anywhere could
  still resurrect past it (per-lane quiescence), and the next pass drops the
  remove record itself. Size-armed (COMPACT_AT) on the heartbeat tick,
  journal-surfaced, monitors rescan on shrink. The M0 unbounded-growth debt is
  CLOSED in memory and on disk (the M4e WAL snapshot+swap).
- **M4c the confirm ladder is LIVE** (kernel/confirm.ts): a probe asks "has
  (origin, seq) reached this level?" and the ONLY admissible evidence is the
  watermark ladder — `replicated` = a majority of the committed view holds it
  SHIPPABLE, `persisted` = a majority holds it DURABLE, never `applied` (v2's
  recvReplProbe answered off the apply watermark: a documented
  guaranteed-false-positive, now unwritable). Evidence rides the digests that
  already flow (the `d` map is the shippable tails; durable mode adds a `p`
  map) — zero new frame types, convergence on the heartbeat cadence. Every
  view install RECOUNTS every open probe; the kernel never times out on its
  own (evidence is monotone — deadlines are the embedder's, cancel answers
  false with the count reached); the registry is bounded (MAX_PROBES,
  drop-oldest, surfaced). The M3 residual is demonstrably closed for confirmed
  writes: a CONFIRMED write survives an ownership handoff exactly-once (the
  lost-ACK retry cannot outrace what a majority already holds — pinned as a
  sim schedule).
- **M4e the restore proof is LIVE** (the WAL snapshot+swap + the full-cluster
  kill): `sink.snapshot(batch, rows)` atomically REPLACES the whole WAL with
  the current log re-encoded under fresh chain links (the shell writes tmp +
  fsync + rename inside an ordered io-queue — which also fixed a latent M4b
  bug: threadpool fs.write completions are not order-guaranteed, and two
  swapped appends would have replayed as a false chain hole on a CLEAN
  restart); durable advances to the log tails on the swap echo; arming is
  rows-since-last-swap ≥ SNAPSHOT_AT on the tick, after compaction, so the
  file is O(live cells + SNAPSHOT_AT) always. THE PROOF: kill −9 an entire
  3- or 5-node cluster mid-workload at any seed — torn tails, one lying disk,
  io failures, swaps mid-flight — restart every node from its directory
  alone, and the mesh re-forms (boot records + the rejoin self-ballot),
  converges, and loses ZERO persisted-confirmed writes (150×3 + 150×5 seeds
  expected-empty; sim + a real-filesystem Tier-3 twin). The sweep caught a
  REAL M4d soundness bug while this slice was built: the compaction frontier
  and tombstone quiescence trusted `applied` marks, which a crash regresses —
  a lying disk's reborn lane resurrected a removed cell after every fence was
  compacted away cluster-wide (seed 27). Both now read CRASH-STABLE durable
  marks in durable mode, and a detected lie condemns the restore outright
  (`node.condemn()`: fold reset + clean swap + refold from the cluster — the
  proven wiped-disk path). Honest limits, stated: `replicated` does not
  survive a majority-simultaneous crash (that is `persisted`'s rung);
  persisted-intact assumes a MINORITY of lying disks (fsyncgate's fault
  model — a quorum counted mostly on betrayals is unrecoverable by any
  design); and a lie confined to the newest un-chained-over row of a lane
  evades the hole detector (closing it needs chained-over durable marks in
  the digest — M6 digest work, tracked).
