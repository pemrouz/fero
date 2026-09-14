# ISSUES — bugs discovered, with evidence

Bugs found while working on the debugger, recorded so they are not lost. Each
entry: where, symptom, root cause with file:line, a suggested fix. Open items
sit first; fixed ones stay at the bottom with the commit that closed them.
Design-level open work still lives in [IDEAS.md](IDEAS.md); settled
decisions in [DECISIONS.md](DECISIONS.md).

## Open

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
