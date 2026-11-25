# Notes on the ledger

What the ledger leaves out, what was settled when its layers were put together, and what is still open. Counts are from `tools/grid.mjs` *(counted)*. Everything else here is *reasoned* unless marked.

## The base: 55 mechanisms

The design's base is 55 mechanisms and 418 rules in the study's `simplicity.json` *(counted)*. LAYERS 0.2 says 416, because it counts two records one rule lower: `route-smart` as 1, not 2, and `presence-rows` as 6, not 7 *(checked: LAYERS 2.3, 3.3 and 12)*.

- **50 are in the ledger.** 49 are whole. `tier` is in part: 4 of its 10 rules. Since V5-30, `stream-numbers` holds what `issue-order` held, and part of `client-sessions` and `srchi-marks`.
- **5 are written off for the first build.** BUILD 3.5 names three of the causes: answer stages, the tier and restore. The `none` rung, forks and the slow-leader rule are **a reading of LAYERS 11**, which was written for the older one-slice build; BUILD 3.5 does not name them. The write-offs cost bars: see question A below.

| Mechanism | Base rules | Where it is | Why it waits |
|---|---|---|---|
| `ack-stages` | 12 | [later.json](later.json) | Answer stages are built second. The first build answers only after the commit |
| `none-rung` | 4 | later.json | A reading of LAYERS 11: the rung with no disk, and relays, come later. Costs P-06's second rung and PERF-03 |
| `restore-mark` | 5 | later.json | Restore comes with the tier (BUILD 3.5). Costs OPS-07 |
| `tier` | 6 of 10 | later.json | Uploads to the object store and snapshot layers come later. Local segments and their deletion stay in the first build |
| `forks` | 7 | later.json | A reading of LAYERS 11: forks need the tier. Costs P-18, TEST-06 and half of OPS-07 |
| `slow-leader-self` | 3 | later.json | A reading of LAYERS 11: never built or modelled. F-18 is a MUST that leans on it |

So 37 base rules wait, all 37 written in `later.json`, and one more is folded: the base's `presence-rows` rule 7 is `client-sessions.5`. The first build keeps 380 of the 418 *(arithmetic)*.

## Settled when the layers were put together

One rule has one home. Where two layers held the same rule, one record stays.

- **`link-pings`** lives in L0 only.
- **The protocol version** is `cluster-version.1`: every frame carries it. `links.2` no longer repeats it.
- **The carried set of a slot move.** `slot-move.15` holds the list and the rule that the target opens only with every part. Each part's own carry rule stays with its mechanism (`stream-numbers.10` and `stream-numbers.11`, which took over the session, mark and issue-number carries in V5-30, `slot-sequence.2`, `writer-time.7`, `caller-keys.11`, `subscribe.23`). So `slot-move.15` counts as 1.
- **A diff entry's version.** `data-sink.4` holds it; `row-version.1` holds where the version comes from. L3's copy is dropped.
- **The version column** is `data-store.2`, slice 3. `row-version.1`, slice 1, no longer says how `data` keeps the version.
- **Ready when every group's picture has come** is `selection.1`. `open.3` is the open's promise on top, at low 0.
- **One store per resource** is `whole-hold.1`. `data`'s copy is dropped.
- **Dropped as repeats**, in the layers' own checks: a local snapshot rule (it is `raft-snapshot.4`, `raft-snapshot.8` and `journal.11`), two surface rules (they are `subscribe.25` and `types.1` with `log-reader.2`), and one `data` rule (it is `data-merge-contract.6`).
- **The decision field of a base rule is null.** Raft's rules are the base design's own. That they run in Rust is V5-23 item 1, which is not a rule's why.
- **A rule the Raft port's code carries is in slice 1.** Slice 0 proves the port and builds no rule; slice 1 turns the port on, so its 77 records go on together (63 read from Raft's spec, 14 model-checked). Three Raft records are fero's own on top of the port and go on at first use, in slice 2: `raft-config.15`, `learners.3`, `raft-prevote-checkquorum.7`. The gate holds this.
- **Every budget is in one file.** BUILD 1.1 puts a slice's budget in `slices.json`. Here the slices' and the layers' budgets are both in `budget.json`, so one card sets one file. The budget is on the margins only: no cell of the grid has one.
- **Three rules are the operator's** (`cluster-credentials.10` to `cluster-credentials.12`). No code can carry their id; their `proof` says so.
- **Four rules had no home and were added:** `access-rules.1`, `stream-rows.2`, `healing-self.20`, `shape-version.1`.
- **Four more were added from the decisions:** `derive-view.12` and `emit-fold.6` (the bucket limit, V5-20 item 10), `scan.17` (the verb on the surface, V5-20 item 4), `write-surface.15` (no bare mark and no claim for a client of a resource with methods, V5-17 item 13). `derive-view.9` now also holds the bump addressed to a group (GROUPS V6).
- **Low has one meaning.** Low is 0 only where a named other record may already hold the rule. 9 records are so; 158 others that were at low 0 to match the study pages' ranges went to 1. Which 9 is this page's reading.
- **High is over 1 where one sentence may hide more than one rule.** 34 records that join two rules in one sentence were raised; `methods.10` holds three. The pick of those 34 is a reading.
- **A partial model is marked.** 30 records are known by a model of a smaller or an older form of the rule; their evidence starts with "partial model:". `handback.1`, whose pull form no model ran, is "reasoned".
- **23 ids are retired** ([retired.json](retired.json)): five dropped as repeats when the layers were put together, and 18 replaced by `stream-numbers.1` to `.11` (V5-30).
- **Records that sit in a layer other than their mechanism's:** `srchi-marks.1` is L5, `srchi-marks.15` is L4 and `scan.17` is L4. The layer is a field, not part of the id.

## Open questions

Each needs a pick before its slice. None blocks the budget card.

**For the owner** (the budget card was answered as V5-25)

A. **Answered: V5-26.** The MUSTs the first build does not reach are restated as after the first build, each with its reason: P-06's `none` rung and PERF-03; P-18 and TEST-06 (forks); OPS-07 (restore); F-18 (the slow-leader rule; the watchdog of slice 2 covers a stuck main thread only, *reasoned*); OPS-13 (erase, no rule yet). F-12's recover command is built in slice 2: `recover.1` to `recover.3` hold the command, beside `meta-directory.2`, `meta-directory.3`, `meta-directory.7` and `slot-table.7` (slice 3, with slot epochs).

**Slices**

1. The Raft port's rules for snapshots, learners, leader transfer, the read index and membership changes are counted in slice 1 with the port, but are first used in slice 2, and BUILD 3.4 lists snapshots and learners as left out of slice 1. If a slice means first use, 32 records move from slice 1 to slice 2 (225 and 164). The budget card names this. Also, `judged-writes.1` names six conditions and slice 1 builds one conditional op (BUILD 3.4); which one is not picked.
2. `links.6` (a server listens only on its own machine until the door) is a refusal that slice 7 removes. Is such a stand-in a ledger record?
3. `migrate.1` is in slice 8 because it needs `scan()`, but the 22 patterns run in slice 6.
4. `lock-rows.2` and `lock-rows.3` are in slice 5, since the view form of `derive` needs them; the plan lists locks in slice 6.
5. `timeline-merge` is in slice 7, but slice 1's viewer may already merge logs by writer time.
6. `open.6` is in slice 1; its last clause leans on the clean stop of slice 2.
7. The byte-rate cap is in slice 2, though slice 1 already has a catch-up. Whether a move's fenced part skips the cap is not decided.

**Homes and repeats still to judge**

8. Does a server that holds several groups keep one `data` store per resource, or one per group? `whole-hold.1`, `hold.1`, `data-store.4` and `data-partials.1` lean on the answer.
9. The answer after the commit has a side in three layers: `slot-table.2`, `subscribe.24` to `subscribe.26`, `writer-judging.10`. Kept as three; `slot-table.2` is at low 0.
10. A full client queue has three records: `admission-credits.4` (the bound), `write-surface.12` (how it shows), `srchi-marks.13` (a marked write waits).
11. `commit-object.1` and `data-sink.1` both say one commit object, by reference.
12. Write numbering (`stream-numbers`, `slot-sequence`) is in L2; the plan lists it under L1.
13. `record-key.1` (the first key's hash picks the slot) is in L2; it may be L1's.
14. `derive-view.6` is in L5, though the check runs at the leader.
15. The four fences at the saga's intent rows (`saga-intents.20`, `saga-intents.21`, `saga-intents.28`, `saga-intents.29`) may be cases of `fence-tokens.1`.
16. Does a write that changes nothing raise the fence table? If not, `consumer-groups.5` goes.
17. `small-project-timers.1` may be a config default, not a rule. `world.1` to `world.3` may be the simulator's.
18. `data-lane.3` and `data-partials.4` may be a shape and a pin, not rules. `data-store.9` rests on one sentence.

**Rules with no record yet**

19. `fero.drop` and `fero.erase`: no page states their rules, so OPS-13 has no record; V5-26 restated it as after the first build.
20. A root write from an untyped or hostile client: refused at the client (`write-surface.5`); nothing makes the leader refuse it.
21. **Settled by V5-26.** Operator recovery is the recover command of slice 2 (`recover.1` to `recover.3`), so F-12 is placed. Which copies' logs it compares, and how it lists what may be lost, are slice 2's to settle.
22. Peer clock readings on Raft's messages, which `writer-time.1` needs.
23. The two rules of the line (bytes cross in batches through a fixed list of calls; kernel code touches no file, socket, clock or thread) are held as budgets and pins, not as records.
24. Health: every wait shows its reason. Read as an interface, not a rule.
25. Keeping leader hints fresh; a data upgrade that switches per group; the wire form of a bump addressed to a group (`derive-view.9` holds the rule, SHAPES has no frame for it).
26. The code a deriver or a fold ends with past its bucket limit (`derive-view.12`, `emit-fold.6`): no page names it, and `too-many-keys` is taken by once names. Also `old-fold`, `rows.max` per group, when a fence table entry may go, and the guard for when most clocks are wrong.
27. `healing-self.18`'s refusal has no name; `busy` is taken.
28. `fero.revoke` ends access within one ping, but the revoked list is said to come from config. `cluster-credentials.8`, `cluster-credentials.11` and `cluster-credentials.14` lean on the answer.
29. If restore stays later, a move made before it never puts its epoch in the restore mark. Either the move writes the mark from slice 3, or restore seeds it from the home log.

**Evidence that is owed**

30. The one-commit slot move has no full model yet. `slot-move`'s records and the carry rules are among the 33 partial models: known from a smaller probe or from the three-step move.
31. The merger's rules (`merger.6` to `merger.11`) were run on the three-step move.
32. The saga's fences were modelled with locks and sagas in one group.
33. `ws-listener.1` to `ws-listener.3` are readings; no source words them.
34. The "seeds" and "measured" records of L3 to L5 and D rest on prototypes beside `data` 4, in one process, not on v5 code.

**The pages**

35. **Settled by V5-27.** Servers run on Linux from slice 1; macOS and Windows servers come in slice 7.
36. [SHAPES.md](SHAPES.md) section 12 lists 30 open questions on bytes. It marks `SNAPSHOT` and `TIMEOUT-NOW` as first sent in slice 2, though their Raft rules are on from slice 1 (question 1). Two are conflicts in the record: whether a batch or a record is one Raft entry, and the two meanings of `busy`. Two need a card: the value's encoding, and one shared log against a journal plus segments.
37. The budget: see [cards/0001-budget.md](cards/0001-budget.md).

**Decision fields**

38. `growth.2` to `growth.4`, `clean-stop.4` and `clean-stop.5` keep a null decision. They are E-59's own rules; V5-20's items 22 and 23 and its consequences name only the leaver that stays, the exit and growth's first rule.
39. `ws-listener.1` to `ws-listener.3` and `links.6` name V5-24 item 2, the accepted plan, as their why: the plan is where the listener and the trusted-network stand-in are set.
