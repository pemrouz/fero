# ISSUES — bugs discovered, with evidence

Bugs found while working on the debugger, recorded so they are not lost. Each
entry: where, symptom, root cause with file:line, a suggested fix. Open items
sit first; fixed ones stay at the bottom with the commit that closed them.
Design-level open work still lives in [IDEAS.md](IDEAS.md); settled
decisions in [DECISIONS.md](DECISIONS.md).

## Open

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
