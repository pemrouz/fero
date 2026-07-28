# DESIGN-M7 — debug tooling, full (the DIAG channel, the shrinker, the diagnostics handle)

Panel record: 3 open questions × 2 independent candidates (minimal-surface vs
durability-first) × 1 skeptic judge each; every claim verified against the tree
before synthesis. This document is the reconciled outcome — the implementation
contract for the M7 slices. The M7 acceptance line (plan-v3.md §11): DIAG verb +
auth allowlist; capture a seeded chaos failure, open the shrunk trace, time-travel
to the violating event; live-dash a real 5-node cluster with the cid write-route
timeline; honesty promotion-gate green on an empty capture.

Cross-panel reconciliation (the one genuine conflict): the handle panel consumed a
single-verb, no-HELLO, monolithic `op:'capture'` DIAG; the DIAG panel proved the
monolithic pull deterministically drop-loops on any node whose state outgrows one
frame (FrameError → link drop → re-dial → same frame) and designed the structurally
non-member session latch instead. **The DIAG panel's wire design is the contract**;
it independently satisfies the handle panel's real requirement (an attach client
must never be a phantom membership participant). The handle panel's consumer-side
rules all survive: absent-rows honesty, the pull coalescer, budget-under-poll,
framer discard on stall, vocab union-if-consistent.

## §1 The DIAG channel (kernel)

**Verbs** (codec.ts, append): `DIAGQ: 23, DIAGA: 24`. Paired direction-split verbs,
no subcommand byte — control frames carry exactly ONE value via encodeControl; the
op rides INSIDE the value (the DIGEST-r / HELLO-role idiom). Keeps #dispatch's flat
fail-closed switch, matching HAVEQ/HAVEA, CALL/RESULT, WACK/WNACK.

**Config** (NodeOpts): `diag?: { allow: Record<string, string> }` — name → opaque
bearer token. Absent/empty = channel dead, every attach denied (fail closed, the
durable/client/replicas idiom). Names are audit identities and ride the journal;
tokens never do. Object values ({token, scopes}) reserved post-1.0.

**Session latch**: `LS = { hello, admitted, diag }` (appended; NO new Link fields —
state IS the latch). Client connects TCP; the node ships its normal HELLO on linkUp
(unchanged — the client learns {u,i,l} free). Client HELLO carries `r: 2, t: token,
p: 1`; non-diag HELLOs stay byte-identical. The HELLO handler grows exactly ONE
branch (after the shape check, before self-reject/dup-link):
`if (link.state === LS.diag || v.r === 2) return diagHello(this, link, v)`.
diagHello (new kernel/diag.ts) is the whole machine:
- used-link guard (the B1 fix): `link.state !== LS.hello || link.uuid !== ''` →
  frameDrop, dead, close — covers both re-HELLO on LS.diag AND r:2 on an admitted
  member/client link (whose byUuid entry must never ghost).
- no/empty allow → deny 'no-config'; non-string t → deny 'malformed'; constant-time
  compare (length + XOR) against each entry; match → LATCH else deny 'bad-token'.
- LATCH: `link.state = LS.diag; link.noRedial = true`; uuid/byUuid/clientLinks/
  membership/scope untouched; emit diagAuth; ship DIAGA `{id:0, ok:1, u, i, p:1}`
  (the ACCEPT — kept because the deny frame is best-effort under socket.destroy, so
  close-before-ACCEPT is the one reliable client contract).
- DENY: emit diagDeny with the typed reason (journal-only); ship DIAGA
  `{id:0, ok:0, e:'denied'}` — ONE constant wire reason, no enumeration oracle (the
  wire never distinguishes no-config from bad-token); dead; close. The presented
  token is never journaled.

**Structural non-membership, all by existing guards**: not in byUuid (spoofed-uuid
dup-keeper eviction impossible; scope.linkDown unreachable — uuid ''), not
LS.admitted (excluded from admitted(), genesis, suspicion, heartbeats, AE floor;
every admitted-only verb closes it), not in clientLinks and never synced (zero
replication fan-out, zero per-record flush tax while attached). PING/PONG is
state-blind; the client heartbeats. One Framer, one crc net, one backpressure
plane — no second transport doorway.

**Ops** (requests `{id ≥ 1, q, ...}`; every reply echoes `{id, ok, u, i}` — per-pull
restart detection):
- `q:'meta'` → `{l, p: 1, vocab: JK}` — the node serves its OWN vocabulary
  (self-describing capture across processes; version skew is data).
- `q:'node'` → the diagNode fold: uuid/listen/seq/epoch/view/gate/pw/stateHash/
  journal.n/dropped/streams/origins{tail, base}/links. One dispatch = atomic; base
  = the compaction floor the logs cursor needs.
- `q:'journal', f (INCLUSIVE), n?` → `{t, d, f0: max(f, n-cap), lost: f0-f, ev,
  next?}` — ≤ DIAG_MAX (4096) rows/frame; loss triple-surfaced, never spliced.
- `q:'logs', o, f (EXCLUSIVE — the digest/AE convention), n?` → `{o, tail, ev,
  next?}` — chunked; values ride the value codec raw; empty ev + tail > f means
  "compacted past you", not "caught up". (The inclusive/exclusive split is an
  off-by-one factory: loud comments at both sites + adversarial cursor tests are
  load-bearing.)
- `q:'state'` → `{sh, cells}` — SINGLE frame, never chunked (append-only sources
  chunk torn-proof; a mutable map must not tear); encoded in a local try:
  FrameError → `{ok:0, e:'too-large'}`, never the bytesIn net.
- unknown q → `{ok:0, e:'bad-op'}`; malformed → `{ok:0, e:'bad-args'}` — keep the
  link (newer bridge probing an older node degrades typed, never fatally).
Per-frame auth thereafter is the state check only: DIAGQ outside LS.diag →
frameDrop + close; DIAGA arriving at a node → frameDrop, keep link.

**Journal kinds** (append): `diagAuth: 68` (a=link, b=allowName), `diagDeny: 69`
(a=link, b=reason), `diagPull: 70` (a=link, b=op, c=rows — emitted AFTER the reply
builds, so a pull never contains its own row). **Emission policy**: diagPull only
for the data-bearing reads (node/logs/state); q:'journal' and q:'meta' are NOT
journaled — journaling reads-of-the-journal at follow cadence evicts the history
being followed (a 1 Hz live-dash would eat the 4096-cap ring in minutes). The audit
anchor is diagAuth + linkDown. The asymmetry is deliberate; do not "fix" it.

**Parity by construction**: kernel/diag.ts exports the diagNode fold + reply
builders; capture.ts's captureNode is RE-BASED onto them — one fold, two consumers
(the wire and the in-process capture); a deepEqual pin (kinds ≥ 68 filtered)
backstops.

**Inertness**: kernel/diag.ts is pure (node, link, value) → emits + ship. No new
Event kinds, no EffectSink methods, zero shell/sim changes. Every addition is
structurally unreachable without an r:2 HELLO or verb 23/24 arriving; the 1000-seed
sweep stays byte-identical at exactly 237,451 events.

**Known posture** (documented, not solved): the token crosses cleartext — run DIAG
on trusted networks or a tunnel (plan §12: auth beyond the allowlist is post-1.0).
The r:1 client-plane uuid-spoof hole predates DIAG and remains (IDEAS, under
peer-auth); DIAG itself is immune. WAL segments are NOT pullable (captureNode
parity is the bar; WAL bytes are the shell's file).

## §2 The shrinker (sim/shrink.ts)

**Unit**: `Step = {at, op:'write', uuid, recs} | {at, op:'partition', a, b} |
{at, op:'heal', a, b}` — one external stimulus, fully literal; posting draws no rng.
**Contract**: `Build = (subset: Step[] | null) => Built` — ALL build-time rng draws
run unconditionally (faults, plans, windows); only the subset is POSTED. Removing a
step therefore cannot shift any other step's randomness (replan-to-burn: determinism
is self-enforcing, no mirrored rng bookkeeping to desync).

**Harness split**: `writesPlan(rng, uuids, count, spanMs): Step[]` with
byte-identical draw order; `writes()` becomes plan-then-post (API unchanged; sweeps
untouched). `sweepBuild(seed, nodes, writes): Build` reproduces run.ts's sweep
scenario as data; run.ts calls `sweepBuild(...)(null)`. The refactor is pinned by a
golden test (the pre-refactor writes() body frozen inline, 200 seeds, deepEqual on
trace + events) AND the frozen-sweep count (237,451) as final authority.

**Algorithm** (every candidate re-run validated, capped at
`maxEvents: max(4 × baselineEvents, 50_000)`):
- P0 reproduce gate: build(null) must re-fail with the same class, else return null
  (caller keeps the unshrunk capture and says so).
- P1 horizon truncation (monitor classes): re-run with stopOnViolation, drop steps
  past sim.now, confirm by re-run.
- P2 greedy single-removal to fixpoint (1-minimal; pure core exported as
  `minimize<T>(items, holds)` for Sim-free unit tests). Budget cap (default 2000
  runs) → best-so-far, `capped: true`.
- Final: build(minimal) re-run with stopOnViolation — that frozen-at-the-violation
  Sim is what gets captured.
- Deliberately absent: ddmin (greedy is already 1-minimal; two-phase is surface
  without payoff at n≈45), node-count reduction (3-node sweep: 3→2 changes majority
  math; extension for future ≥5-node schedule scenarios), rng lane-splitting.

**Oracle** — same FIRST-failure class: monitor NAME for violations (detail is
witness, not identity — details embed shifting seqs), named end-check otherwise
(`never-formed | never-quiesced | diverged | undrained` — named for the FAILURE,
via pluggable `ends` so scoped scenarios can shrink against exactlyR etc.),
digit-run-normalized message for throws. Residual same-monitor-different-bug risk
is mitigated by honesty: original + final details ride the artifact side by side.

**exec.ts** (+3, default-off): `run({stopOnViolation})` returns right after the
violation push — `sim.events === violations[0].event`, every journal cut at the
violation instant. So the capture ends AT the violation and the viewer opens there
by construction — no scrubber changes, no Violation shape changes.

**Artifact**: `captureSim(sim, meta?)` gains an additive optional `shrunk` block:
`{from: {steps, events, violation, fail}, steps, repro: {seed, nodes, writes,
draws, faults, steps}, removed, runs, capped, atViolation}`. The repro block is
standalone-replayable: `replayShrunk(repro)` = new Sim(seed) → cluster() → burn
`draws` rng calls (counted from the REAL build via a counting wrapper, never a
mirror) → install faults from data → post steps — the fix-verification loop
(`npm run shrink -- --replay captures/seed-N.shrunk.json`).

**run.ts**: failing seeds keep writing `captures/seed-N.json` exactly as today,
then auto-shrink (opt-out `--no-shrink`) writes `captures/seed-N.shrunk.json` +
prints `shrunk A→k steps (r runs)` with original-vs-final details.

**Viewer honesty**: summarize passes `shrunk` through; the viewer shows a warn pill
(`shrunk A→k steps · ends @ violation`) and renders convergence as
`mid-flight @ violation` (warn, keyed STRICTLY on the recorded atViolation fact) —
never a fabricated `diverged ✗`.

**The acceptance mutation** (the V1d mutation-test precedent): a fence-blind log
re-append — wrap one node's `writes.inbound`; on `seq <= applied` push the dup
straight into logFor(origin) and swallow it. Fires only on real chaos duplicates;
trips `log-monotone` per-event; touches neither journal nor state (verifyReplay
stays green; the non-ascending pair rides the artifact as the physical witness).
The end-to-end test: find the mutant seed, prove the un-mutated build green on the
same steps, shrink, assert 1-minimality spot-checks, capture, verifyReplay ok,
stateAt(violation) reachable, summarize().shrunk truthy.

## §3 The [diagnostics] handle (api) + serve/attach

**Placement**: new `api/diagnostics.ts` (~45 lines, type-only imports) — the
unique symbol + `Diagnostics` interface + the `diag(f)` accessor (the one
sanctioned door). The composer attaches the handle to the returned instance
without widening `Fero`; symbol-keyed = off Object.keys/JSON by language
semantics (pinned by test anyway). internals.ts re-exports all three names.
No Symbol.for (forgeable registry).

**Members** (v2's idiom mapped onto v3's real internals — nothing stubbed):
- `capture(): CapturedNode` — captureNode(rt.node), THE capture format.
- `journal(from?)` → `{n, dropped, events}` — atomic one-call cursor read.
- `served(): number` — Host live-subscription count (the v2 leak guard).
- `confirms()` → `{api, kernel}` — both probe registries; must drain to 0.
- `logSize(): number` — Σ entries over node.logs.
- `compact(): number` — forced frontier-bounded pass + tombstone GC, size-gate-
  free (v2's drive-it-deterministically purpose) BUT **honest refusals: 0 on
  node.armed** (compaction is PINNED under scoping — the member-ranged frontier is
  unsound for holders; both candidates got this wrong, one dangerously) **and 0 on
  node.destroyed**; calls the composer's fold() after (the hook wraps step only —
  without it cluster/journal surfaces lag).
- `drop?(uuid): boolean` — abrupt socket destroy to an identified peer (a real
  network drop; the kernel hears linkDown via 'close'); OPTIONAL — present only on
  real-TCP backings, absent honestly elsewhere.
- **Dropped without stubs**: observe/observing (the journal cursor + public tap are
  the pull-spine answers — v2 DECISIONS O), isolate/heal (a TCP shell cannot hold a
  partition honestly: redial/revive heals within redialMs; the honest primitive
  lives at the sim tier; the M8 sketch — dial-refusal set + identified-kill +
  revive suppression — goes to IDEAS, not code).

**serve.ts**: `--nodes N` default 5 (the M7 live-dash); raw Runtimes stay (real TCP
is real; the write path under demonstration stays the kernel's). The char-sum
workload owner is uncorrelated with the kernel ring, so at N=5 ~80% of writes
owner-forward — the cid write-route timeline (writeForward/writeAck legs) lights up
by construction. `--live` × `--attach` together = loud startup error.

**attach.ts** (new): DiagClient over the kernel's own Framer/encodeControl
(imported, never reimplemented) — r:2 HELLO latch, promise-per-id, cursor loops,
segment handling. Token via `FERO_DIAG_TOKEN` env (never argv — ps-visible).
`/capture.json` performs FRESH pulls per HTTP request (pull-spine end-to-end;
budget strictly under the viewer's 1.5s poll) with an in-flight coalescer; no
timer anywhere — the viewer's poll is the only cadence in the system. On
timeout/FrameError the socket AND framer are discarded (a half-read framer is
never reused). Assembly (owned by capture.ts): answered nodes only, plus
`absent: [{target, reason}]` with the closed reason set
`refused | timeout | unauthorized | frame | vocab-mismatch` — a node that won't
answer is NEVER synthesized into nodes[]. Vocab: union of answering nodes' vocabs
when consistent (append-only JK makes honest skew subset/superset); a CONFLICTING
mapping demotes that node to absent 'vocab-mismatch'. Segments key on (u, i):
an incarnation change opens a NEW capture segment, never stitches (the origin-lane
rebirth rule applied to diagnostics); n-regression is a secondary tripwire only.
Immutable log entries MAY be cached between rebuilds only with evict-below-base
reconciliation (a capture must never show entries the node no longer holds).

**model.mjs**: `converged: null` when nodes.length === 0 (kills the vacuous
green), `absent` passthrough, exported closed enums ROUTE_STATUS/ABSENT_REASONS.
**viewer.html**: absent rows as marked dead chrome (address + reason, no
fabricated node card); `converged: null` renders "no nodes", never a green badge.

## §4 The honesty promotion gate (tools/debug/honesty.test.ts)

Testable without a browser = the fold layer (the only place data-derived strings
are minted) + a source-level viewer pin; DOM assembly is the named residue.
1. Fold closure on empty REAL-PRODUCER fixtures (`captureLive([])`, and
   captureLive of a constructed-never-stepped Node — kernel purity means the
   constructor emits nothing): exhaustive deep-equal goldens for summarize/routes/
   contested/verifyReplay/stateAt/kindNames — any synthesized field breaks the gate.
2. String-leaf traceability: every string leaf of every fold output (empty AND one
   real captureSim fixture, AND a shrunk fixture) ∈ strings-in-the-capture ∪
   ROUTE_STATUS ∪ ABSENT_REASONS ∪ vocab names ∪ cellKey encodings — with ONE
   carve-out: verifyReplay's prose reasons are pinned by template regex and
   exercised by a deliberately-truncated fixture (the carve-out is itself tested).
3. Absent honesty: an absent row changes summarize verbatim and NOTHING else —
   absence contributes zero facts.
4. The viewer's data-plane pin, source-level: viewer.html has exactly one module
   import line importing exactly the model's folds, and no local fold redefinition.

## §5 Slice order and validation

S1 shrinker (harness split is sweep-critical → byte-identity check immediately);
S2 DIAG kernel (HELLO branch is the safety-critical diff — keep it to one branch;
byte-identity again); S3 handle; S4 attach + serve + viewer; S5 honesty gate +
acceptance end-to-end. Every slice: tests + perf green before moving on; the
1000-seed sweep at exactly 237,451 events after S1 and S2; perf posture for the
new surface is structural (nothing on a hot path) + the existing suite.

## §6 Landed — outcome, decisions, and the residual ledger

**Shipped green:** 288/288 tests (+34 over M6), 20/20 perf gates, 1000/1000 sweep
at exactly 237,451 events. Acceptance line demonstrated end-to-end: a chaos failure
under the fence-blind mutant shrank **40 steps → 1 in 6 candidate runs**, the
capture ends AT the violating event (events === violations[0].event), time-travel
and replay-verify both green. Live dash measured at 5 nodes: converged, 44
write-route rows, 25 owner-forwarded writes with acks. Attach measured against a
real 3-node cluster + a dead address: 3 answered, 1 typed absent row, 68 route
rows, replay-verified, 70-kind vocabulary served by the nodes themselves.

**Decisions recorded (do not silently reverse):**
1. **The diagPull emission asymmetry.** Data-bearing reads (node/logs/state) are
   journaled; journal/meta pulls are not. Journaling reads-of-the-journal at follow
   cadence evicts the history being followed — a 1 Hz dash eats a 4096-row ring in
   minutes. The session audit anchor is diagAuth + linkDown.
2. **compact() refuses when armed.** A diagnostics member that can destroy data is
   worse than one that declines; the member-ranged frontier is unsound for holders.
   Refusal is documented and asserted, never silent.
3. **isolate/heal are NOT on the handle.** A TCP shell cannot hold a partition
   honestly (redial/revive heals within redialMs). The honest primitive stays at the
   sim tier. M8 sketch if ever wanted: dial-refusal set + identified-kill + revive
   suppression in the shell — three coupled pieces, not a one-liner.
4. **Absent beats faked, everywhere.** A node that will not answer is an `absent`
   row with a closed-set reason, never a synthesized node card; folds range over
   nodes[] only, so no fold can mint a status about an uncaptured node.
5. **The honesty gate verifies derivations, not shapes.** Composite identities
   (`origin#seq`, cellKey) pass only when every PART traces to a capture fact — the
   gate caught this on its first run and was tightened rather than loosened.

**Residual, stated:**
- The DIAG token crosses cleartext (plan §12 posture). Trusted networks or a tunnel.
- The `r:1` client-plane uuid-spoof hole predates DIAG and REMAINS: any client HELLO
  can trip the dup-link keeper. DIAG is structurally immune; the client plane is not.
  This belongs with peer-auth, post-1.0 — DIAG's immunity is not its closure.
- `q:'state'` is single-frame by design (a mutable map must not tear across pulls).
  A node whose flat state alone exceeds MAX_FRAME answers typed 'too-large' — that
  node's state is honestly unpullable. Relief valve if it ever bites: a keyed range
  cursor with an EXPLICIT torn-snapshot marker; never silent chunking.
- The journal (inclusive) / logs (exclusive) cursor split is an off-by-one factory.
  Both sites carry loud comments; the adversarial cursor tests are load-bearing.
- The bridge does not yet cache immutable log entries between rebuilds. When it
  does, the evict-below-base rule is mandatory: a capture must never show entries
  the node no longer holds.
- Viewer DOM template strings are the named residue of the honesty gate — the fold
  layer is policed mechanically; the page's own chrome is policed by review.
