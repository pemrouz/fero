# fero v4 — status

*fero v4 = fero v3 migrated onto data v4 (the sibling `data` repo = data v3 +
the W1–W17 wishlist, ALL LANDED — see ../data/STATUS.md). Scaffolded
2026-08-01 as a full copy of `v3/` (fero-v2 tip `1d94ad6`); PROMOTED TO THE
REPO ROOT 2026-08-16 (package `fero` 4.0.0; the v2 surface + frozen v3 tree
live on at the `master` branch tip — v3 stays the A/B reference there). Plan
of record: DESIGN-DATA3.md §4 (design decisions) + §5 (D0–D5), at the
`master` tip under `v3/`; this file tracks the D-phases.*

Run from the repo root: `npm test` (355 + the 18-clause data contract ride; the directory OFF — FERO_RENDEZVOUS=off) /
`npm run perf` (41 pins) / `npm run sim:scale` (the n=100 deep-sweep registry,
script-tier).

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
  glossary + ONE hover layer ([tools/debug/eli5.mjs](tools/debug/eli5.mjs),
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
