# Interacting pairs of mechanisms (DEV-02)

Built by `python3 tools/judging.py pairs` from [mechanisms.json](mechanisms.json). Two mechanisms interact when both touch one piece of state and at least one of them writes it.

| Row | Mechanisms carried | Interacting pairs |
|---|---|---|
| DRAFT | 52 | 309 |
| MIN | 48 | 253 |
| RUST | 48 | 253 |
| SRV | 50 | 267 |
| LEAN | 48 | 255 |
| CELL | 48 | 262 |
| LANE | 47 | 232 |
| SPLIT | 52 | 278 |
| PD | 46 | 209 |
| ISR | 45 | 214 |
| SLOG | 49 | 272 |
| OBJ | 37 | 144 |
| V4 | 24 | 52 |
| MIN-P | 48 | 252 |
| MIN-TS | 48 | 253 |
| RLOG | 50 | 268 |
| EMB-V8 | 51 | 269 |
| SIDE | 51 | 277 |
| BUY | 10 | 12 |
| COMP | 50 | 283 |

## Every distinct pair

| Mechanism | Mechanism | Shared state | Rows that carry both |
|---|---|---|---|
| route-forward | admission-credits | route.inflight | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, V4, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | caller-keys | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, V4, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | srchi-marks | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, V4, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| caller-keys | fence-tokens | fence.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, BUY, COMP |
| meta-catalog | consumer-groups | slot.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | forks | meta.catalog, meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | meta-directory | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | none-rung | meta.catalog | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | route-forward | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | subscribe | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | route-forward | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | subscribe | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-members | cluster-credentials | meta.members | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-members | cluster-version | meta.members | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-members | fold-version | meta.members | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-members | meta-catalog | meta.members | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| none-rung | forks | meta.catalog | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| none-rung | subscribe | sub.index | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| route-forward | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| srchi-marks | consumer-groups | sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| srchi-marks | subscribe | sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| subscribe | consumer-groups | sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| subscribe | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| subscribe | presence-rows | group.rows | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | consumer-groups | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | lock-rows | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | presence-rows | group.rows, writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | queue-claims | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| caller-keys | writer-time | time.writer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| fence-tokens | consumer-groups | fence.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| fence-tokens | saga-intents | fence.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, BUY, COMP |
| fold-all | fold-version | fold.version | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, V4, MIN-P, MIN-TS, RLOG, EMB-V8, BUY, COMP |
| lock-rows | restore-mark | slot.epoch | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| lock-rows | saga-intents | lock.rows | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, BUY, COMP |
| raft-commit | raft-config | group.commit, group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | raft-leader-transfer | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | raft-prevote-checkquorum | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | raft-snapshot | group.commit, group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | subscribe | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | writer-judging | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | cluster-credentials | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | fold-version | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | meta-directory | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | raft-leader-transfer | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | raft-prevote-checkquorum | group.config, group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | raft-snapshot | group.config, group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-leader-transfer | route-forward | group.transfer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-leader-transfer | writer-judging | group.transfer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-commit | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-config | group.config, group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-leader-transfer | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-prevote-checkquorum | group.leader, group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-snapshot | group.log, group.snapshot | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | raft-term-vote | group.leader, group.log, group.term-vote | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | subscribe | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | writer-judging | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | admission-credits | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | meta-directory | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | raft-leader-transfer | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | route-forward | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | writer-judging | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | forks | group.snapshot, meta.forks | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | presence-rows | group.rows | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | raft-leader-transfer | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | raft-prevote-checkquorum | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | srchi-marks | srchi.marks | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | subscribe | group.log, group.snapshot | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | writer-judging | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | admission-credits | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | meta-directory | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-commit | group.commit, group.leader, group.term-vote | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-config | group.config, group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-leader-transfer | group.leader, group.transfer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-prevote-checkquorum | group.contact, group.leader, group.term-vote | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-snapshot | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | route-forward | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | writer-judging | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| restore-mark | consumer-groups | sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| restore-mark | subscribe | slot.epoch, sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| srchi-marks | restore-mark | slot.epoch, sub.cursor | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | fence-tokens | writer.logend | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-time | consumer-groups | time.writer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-time | lock-rows | time.writer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-time | presence-rows | group.rows, time.writer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-time | queue-claims | time.writer | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| learners | meta-directory | group.learners | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| learners | raft-snapshot | group.learners, group.log, group.snapshot | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | tier | meta.catalog | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | tier | store.objects | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | learners | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | learners | group.config, group.learners | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | writer-time | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | learners | group.learners, group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | tier | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | tier | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | writer-time | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | fence-tokens | fence.table | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | restore-mark | slot.epoch | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | tier | group.log, group.snapshot, store.objects | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | learners | group.learners | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | tier | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | writer-time | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| tier | forks | meta.catalog, meta.forks, store.objects | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| tier | restore-mark | store.objects | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| tier | subscribe | store.objects | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | fold-all | group.rows | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, V4, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| disk-incarnation | dir-lease | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| disk-incarnation | input-recorder | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| fold-all | presence-rows | group.rows | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| fold-all | subscribe | group.rows | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| meta-members | disk-incarnation | disk.incarnation | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | disk-incarnation | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | fold-all | group.commit | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| raft-commit | quiet-groups | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | raft-readindex | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | disk-incarnation | disk.incarnation | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | quiet-groups | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | raft-readindex | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | fold-all | group.log | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| raft-log | quiet-groups | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | quiet-groups | group.leader, group.quiet | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | raft-readindex | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-readindex | presence-rows | group.rows | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-readindex | quiet-groups | group.read | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | fold-all | group.log, group.rows, group.snapshot | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| raft-snapshot | quiet-groups | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | disk-incarnation | disk.incarnation, durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | quiet-groups | group.leader | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | raft-readindex | group.leader, group.term-vote | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| tier | disk-incarnation | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | dir-lease | durable.log, journal.segments | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | disk-incarnation | durable.log, journal.segments | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | forks | journal.segments | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | input-recorder | durable.log, recorder.tape | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | subscribe | journal.segments | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| journal | tier | durable.log, journal.segments | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| learners | link-pings | group.learners | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| link-pings | meta-members | link.ping, meta.members | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| link-pings | quiet-groups | link.ping | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| link-pings | writer-time | link.clocks | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| quiet-groups | writer-time | group.quiet | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-commit | journal | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | link-pings | group.config | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-log | journal | group.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | link-pings | link.ping | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | journal | group.log, group.snapshot | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | journal | durable.log, group.term-vote | DRAFT, MIN, RUST, SRV, LEAN, CELL, LANE, SPLIT, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-time | fold-all | group.rows | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| controller-commands | cluster-credentials | group.config | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| controller-commands | fold-version | group.config | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| controller-commands | forks | meta.catalog, meta.directory | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| meta-catalog | controller-commands | meta.catalog, meta.directory | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| meta-catalog | move-policy | meta.catalog, meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | slot-move | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-catalog | slot-table | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | controller-commands | group.config, group.learners, meta.directory | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| meta-directory | move-policy | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | slot-move | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-directory | slot-table | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| meta-members | controller-commands | meta.members | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| move-policy | forks | meta.catalog, meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| move-policy | route-forward | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| move-policy | subscribe | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-readindex | fold-all | group.rows | DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, PD, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| slot-move | caller-keys | fence.table, issuer.table, session.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | consumer-groups | fence.table, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | fence-tokens | fence.table, move.record | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | lock-rows | slot.epoch, slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | move-policy | meta.directory, move.lease, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | presence-rows | group.rows | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | restore-mark | move.record, restore.mark, session.table, slot.epoch | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | route-forward | slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | saga-intents | fence.table, issuer.table, session.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | slot-sequence | move.record, slot.epoch, slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | srchi-marks | move.record, slot.epoch, slot.seq, srchi.marks | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | subscribe | move.record, slot.epoch, slot.seq, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | writer-judging | move.record | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | writer-time | time.writer | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-sequence | lock-rows | slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-sequence | restore-mark | slot.epoch | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-sequence | srchi-marks | slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-sequence | subscribe | slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | consumer-groups | slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | move-policy | meta.directory, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | restore-mark | slot.epoch | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | route-forward | slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | slot-move | move.record, slot.epoch, slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-table | subscribe | slot.table | DRAFT, MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | caller-keys | session.table | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | presence-rows | session.registry | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | restore-mark | session.generation, session.table | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | route-forward | route.inflight | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | saga-intents | session.table | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| client-sessions | writer-time | time.writer | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| controller-commands | writer-time | group.config | MIN, RUST, SRV, LEAN, ISR, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | disk-incarnation | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | forks | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | meta-catalog | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | meta-directory | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-commit | controller-commands | group.commit, group.config | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-commit | dormant-groups | group.commit | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-commit | slot-move | group.commit | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | controller-commands | group.config, group.learners | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-config | move-policy | group.config | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-config | slot-move | group.config | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-leader-transfer | controller-commands | group.config | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-log | controller-commands | group.config, group.learners, group.log | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-log | slot-move | group.log | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | controller-commands | group.config, group.leader | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-prevote-checkquorum | move-policy | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | slot-move | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-prevote-checkquorum | slot-sequence | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | controller-commands | group.config, group.learners, group.log | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-snapshot | dormant-groups | group.snapshot | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-snapshot | slot-move | fence.table, group.log, issuer.table, move.record, session.table, slot.epoch, slot.seq, srchi.marks | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | slot-sequence | slot.seq | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | controller-commands | group.config, group.leader, group.learners | MIN, RUST, SRV, LEAN, PD, ISR, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-term-vote | move-policy | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | slot-move | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-term-vote | slot-sequence | group.leader | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | tier | move.record, store.objects | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| writer-judging | client-sessions | writer.logend | MIN, RUST, SRV, LEAN, CELL, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| controller-commands | move-policy | group.config, meta.directory | MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| controller-commands | slot-move | group.config | MIN, RUST, SRV, LEAN, SLOG, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | journal | durable.log | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, MIN-TS, RLOG, EMB-V8, SIDE |
| learners | controller-commands | group.config, group.learners | MIN, RUST, SRV, LEAN, PD, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| link-pings | dormant-groups | link.ping | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, MIN-TS, RLOG, EMB-V8, SIDE |
| quiet-groups | dormant-groups | group.quiet | DRAFT, MIN, RUST, SRV, LEAN, CELL, SPLIT, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-commit | client-sessions | group.commit | MIN, RUST, SRV, LEAN, CELL, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| raft-snapshot | client-sessions | session.table | MIN, RUST, SRV, LEAN, CELL, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | client-sessions | move.record, session.table | MIN, RUST, SRV, LEAN, OBJ, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| slot-move | journal | journal.segments | DRAFT, MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE, COMP |
| controller-commands | disk-incarnation | disk.incarnation | MIN, RUST, SRV, LEAN, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| dormant-groups | move-policy | meta.directory | DRAFT, MIN, RUST, SRV, LEAN, SLOG, MIN-TS, RLOG, EMB-V8, SIDE |
| quiet-groups | controller-commands | group.config | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| quiet-groups | slow-leader-controller | group.quiet | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-leader-transfer | slow-leader-controller | group.transfer | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-prevote-checkquorum | slow-leader-controller | group.leader | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-readindex | controller-commands | group.config | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| raft-term-vote | slow-leader-controller | group.leader, group.transfer | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| slot-move | fold-all | group.rows, move.record | DRAFT, MIN, RUST, SRV, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8, COMP |
| slow-leader-controller | admission-credits | client.credit | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| slow-leader-controller | meta-members | meta.members | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| slow-leader-controller | route-forward | group.transfer | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| slow-leader-controller | writer-judging | group.transfer | MIN, RUST, SRV, LEAN, PD, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| link-pings | controller-commands | group.config, group.learners, link.ping | MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| link-pings | slow-leader-controller | link.ping | MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE |
| meta-members | genesis-conditional-create | cluster.id | MIN, RUST, LEAN, SLOG, OBJ, MIN-P, MIN-TS, SIDE, COMP |
| meta-members | genesis-init | cluster.id | DRAFT, SRV, CELL, LANE, SPLIT, PD, ISR, RLOG, EMB-V8 |
| subscribe | genesis-conditional-create | cluster.id | MIN, RUST, LEAN, SLOG, OBJ, MIN-P, MIN-TS, SIDE, COMP |
| subscribe | genesis-init | cluster.id | DRAFT, SRV, CELL, LANE, SPLIT, PD, ISR, RLOG, EMB-V8 |
| link-pings | genesis-conditional-create | cluster.id | MIN, RUST, LEAN, MIN-P, MIN-TS, SIDE, COMP |
| link-pings | genesis-init | cluster.id | DRAFT, SRV, CELL, LANE, SPLIT, RLOG, EMB-V8 |
| tenant-budget | disk-incarnation | durable.log | DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, EMB-V8 |
| journal | tenant-budget | durable.log | DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8 |
| dedup-window | caller-keys | issuer.table | DRAFT, LANE, SPLIT, SLOG, V4 |
| dedup-window | route-forward | route.inflight | DRAFT, LANE, SPLIT, SLOG, V4 |
| healing-self | cluster-credentials | group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | disk-incarnation | disk.incarnation | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | fold-version | group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | forks | meta.catalog | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | route-forward | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | writer-judging | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| healing-self | writer-time | group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| learners | healing-self | group.config, group.learners | DRAFT, CELL, LANE, SPLIT, COMP |
| link-pings | healing-self | group.config, group.learners, link.ping | DRAFT, CELL, LANE, SPLIT, COMP |
| link-pings | slow-leader-self | link.ping | DRAFT, CELL, LANE, SPLIT, COMP |
| meta-catalog | healing-self | meta.catalog | DRAFT, CELL, LANE, SPLIT, COMP |
| meta-directory | healing-self | group.config, group.learners | DRAFT, CELL, LANE, SPLIT, COMP |
| meta-members | healing-self | meta.members | DRAFT, CELL, LANE, SPLIT, COMP |
| quiet-groups | healing-self | group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| quiet-groups | slow-leader-self | group.quiet | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-commit | healing-self | group.commit, group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-commit | slow-leader-self | group.commit | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-config | healing-self | group.config, group.learners | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-leader-transfer | healing-self | group.config, group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-leader-transfer | slow-leader-self | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-log | healing-self | group.config, group.learners, group.log | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-prevote-checkquorum | healing-self | group.config, group.leader | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-prevote-checkquorum | slow-leader-self | group.leader | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-readindex | healing-self | group.config | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-snapshot | healing-self | group.config, group.learners, group.log | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-term-vote | healing-self | group.config, group.leader, group.learners, group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| raft-term-vote | slow-leader-self | group.leader, group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| slow-leader-self | admission-credits | client.credit | DRAFT, CELL, LANE, SPLIT, COMP |
| slow-leader-self | healing-self | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| slow-leader-self | route-forward | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| slow-leader-self | writer-judging | group.transfer | DRAFT, CELL, LANE, SPLIT, COMP |
| writer-judging | dedup-window | writer.logend | DRAFT, LANE, SPLIT, SLOG, V4 |
| dedup-window | saga-intents | issuer.table | DRAFT, LANE, SPLIT, SLOG |
| dedup-window | writer-time | time.writer | DRAFT, LANE, SPLIT, SLOG |
| healing-self | log-replicas | group.config, group.learners, group.transfer | DRAFT, CELL, LANE, SPLIT |
| healing-self | planner-hints | group.config, group.placement, group.transfer, meta.members | DRAFT, LANE, SPLIT, COMP |
| learners | log-replicas | group.config, group.learners | DRAFT, CELL, LANE, SPLIT |
| link-pings | log-replicas | group.config, group.learners | DRAFT, CELL, LANE, SPLIT |
| link-pings | planner-hints | link.ping, meta.members | DRAFT, LANE, SPLIT, COMP |
| log-replicas | cluster-credentials | group.config | DRAFT, CELL, LANE, SPLIT |
| log-replicas | fold-version | group.config | DRAFT, CELL, LANE, SPLIT |
| log-replicas | route-forward | group.transfer | DRAFT, CELL, LANE, SPLIT |
| log-replicas | tier | store.objects | DRAFT, CELL, LANE, SPLIT |
| log-replicas | writer-judging | group.transfer, group.witness | DRAFT, CELL, LANE, SPLIT |
| log-replicas | writer-time | group.config | DRAFT, CELL, LANE, SPLIT |
| memory-rung | dir-lease | durable.log | DRAFT, CELL, SPLIT, COMP |
| memory-rung | disk-incarnation | durable.log, group.unclean | DRAFT, CELL, SPLIT, COMP |
| memory-rung | forks | meta.catalog | DRAFT, CELL, SPLIT, COMP |
| memory-rung | input-recorder | durable.log | DRAFT, CELL, SPLIT, COMP |
| memory-rung | journal | durable.log | DRAFT, CELL, SPLIT, COMP |
| memory-rung | tier | durable.log | DRAFT, CELL, SPLIT, COMP |
| meta-catalog | memory-rung | meta.catalog | DRAFT, CELL, SPLIT, COMP |
| meta-catalog | planner-hints | meta.members | DRAFT, LANE, SPLIT, COMP |
| meta-catalog | route-smart | meta.directory, slot.table | SRV, PD, ISR, EMB-V8 |
| meta-catalog | worker-map | meta.directory | SRV, PD, EMB-V8, SIDE |
| meta-directory | log-replicas | group.config, group.learners | DRAFT, CELL, LANE, SPLIT |
| meta-directory | route-smart | meta.directory | SRV, PD, ISR, EMB-V8 |
| meta-directory | worker-map | meta.directory | SRV, PD, EMB-V8, SIDE |
| meta-members | log-replicas | meta.members | DRAFT, CELL, LANE, SPLIT |
| meta-members | planner-hints | meta.members | DRAFT, LANE, SPLIT, COMP |
| planner-hints | cluster-credentials | meta.members | DRAFT, LANE, SPLIT, COMP |
| planner-hints | cluster-version | meta.members | DRAFT, LANE, SPLIT, COMP |
| planner-hints | fold-version | meta.members | DRAFT, LANE, SPLIT, COMP |
| planner-hints | route-forward | group.transfer | DRAFT, LANE, SPLIT, COMP |
| planner-hints | writer-judging | group.transfer | DRAFT, LANE, SPLIT, COMP |
| quiet-groups | log-replicas | group.config | DRAFT, CELL, LANE, SPLIT |
| raft-commit | dedup-window | group.commit | DRAFT, LANE, SPLIT, SLOG |
| raft-commit | log-replicas | group.commit, group.config | DRAFT, CELL, LANE, SPLIT |
| raft-commit | memory-rung | durable.log, group.commit | DRAFT, CELL, SPLIT, COMP |
| raft-config | log-replicas | group.config, group.learners | DRAFT, CELL, LANE, SPLIT |
| raft-config | planner-hints | group.config | DRAFT, LANE, SPLIT, COMP |
| raft-leader-transfer | log-replicas | group.config, group.transfer | DRAFT, CELL, LANE, SPLIT |
| raft-leader-transfer | planner-hints | group.transfer | DRAFT, LANE, SPLIT, COMP |
| raft-log | log-replicas | group.config, group.learners, group.log | DRAFT, CELL, LANE, SPLIT |
| raft-log | memory-rung | group.log | DRAFT, CELL, SPLIT, COMP |
| raft-prevote-checkquorum | log-replicas | group.config, group.contact, group.leader | DRAFT, CELL, LANE, SPLIT |
| raft-prevote-checkquorum | planner-hints | group.leader | DRAFT, LANE, SPLIT, COMP |
| raft-prevote-checkquorum | route-smart | group.leader | SRV, PD, ISR, EMB-V8 |
| raft-readindex | log-replicas | group.config | DRAFT, CELL, LANE, SPLIT |
| raft-snapshot | dedup-window | issuer.table | DRAFT, LANE, SPLIT, SLOG |
| raft-snapshot | log-replicas | group.config, group.learners, group.log | DRAFT, CELL, LANE, SPLIT |
| raft-snapshot | memory-rung | group.log | DRAFT, CELL, SPLIT, COMP |
| raft-term-vote | log-replicas | group.config, group.leader, group.learners, group.term-vote, group.transfer, group.witness | DRAFT, CELL, LANE, SPLIT |
| raft-term-vote | memory-rung | durable.log | DRAFT, CELL, SPLIT, COMP |
| raft-term-vote | planner-hints | group.leader, group.transfer | DRAFT, LANE, SPLIT, COMP |
| raft-term-vote | route-smart | group.leader | SRV, PD, ISR, EMB-V8 |
| route-smart | forks | meta.directory | SRV, PD, ISR, EMB-V8 |
| slow-leader-self | log-replicas | group.transfer | DRAFT, CELL, LANE, SPLIT |
| slow-leader-self | planner-hints | group.transfer | DRAFT, LANE, SPLIT, COMP |
| worker-map | forks | meta.directory | SRV, PD, EMB-V8, SIDE |
| controller-commands | controller-sessions | member.session | PD, ISR, SLOG |
| dormant-groups | memory-rung | durable.log | DRAFT, CELL, SPLIT |
| fold-leader | fold-version | fold.version | LEAN, OBJ, SIDE |
| fold-leader | presence-rows | group.rows | LEAN, OBJ, SIDE |
| fold-leader | subscribe | group.rows | LEAN, OBJ, SIDE |
| journal | worker-map | durable.log | SRV, EMB-V8, SIDE |
| memory-rung | tenant-budget | durable.log | DRAFT, CELL, SPLIT |
| meta-members | controller-sessions | member.session, meta.members | PD, ISR, SLOG |
| move-policy | worker-map | meta.directory | SRV, EMB-V8, SIDE |
| planner-hints | log-replicas | group.config, group.transfer, meta.members | DRAFT, LANE, SPLIT |
| slot-move | fold-leader | group.rows, move.record | LEAN, OBJ, SIDE |
| worker-map | disk-incarnation | durable.log | SRV, EMB-V8, SIDE |
| writer-judging | fold-leader | group.rows | LEAN, OBJ, SIDE |
| writer-time | fold-leader | group.rows | LEAN, OBJ, SIDE |
| healing-self | move-policy | group.config | DRAFT, COMP |
| healing-self | slot-move | group.config | DRAFT, COMP |
| meta-catalog | project-groups | meta.catalog, meta.directory, slot.table | MIN-P, COMP |
| meta-catalog | split-policy | meta.catalog | SPLIT, PD |
| meta-directory | project-groups | meta.directory, slot.table | MIN-P, COMP |
| move-policy | route-smart | meta.directory | SRV, EMB-V8 |
| planner-hints | move-policy | move.lease | DRAFT, COMP |
| planner-hints | slot-move | move.lease | DRAFT, COMP |
| project-groups | consumer-groups | slot.table | MIN-P, COMP |
| project-groups | forks | meta.catalog, meta.directory | MIN-P, COMP |
| project-groups | move-policy | meta.directory, slot.table | MIN-P, COMP |
| project-groups | route-forward | slot.table | MIN-P, COMP |
| project-groups | slot-move | slot.table | MIN-P, COMP |
| project-groups | slot-table | slot.table | MIN-P, COMP |
| project-groups | subscribe | slot.table | MIN-P, COMP |
| raft-commit | fold-leader | group.commit | LEAN, SIDE |
| raft-commit | split-record | group.commit | SPLIT, PD |
| raft-log | fold-leader | group.log | LEAN, SIDE |
| raft-log | split-record | group.log | SPLIT, PD |
| raft-prevote-checkquorum | fold-leader | group.leader | LEAN, SIDE |
| raft-prevote-checkquorum | split-policy | group.leader | SPLIT, PD |
| raft-prevote-checkquorum | split-record | group.leader | SPLIT, PD |
| raft-readindex | fold-leader | group.rows | LEAN, SIDE |
| raft-snapshot | fold-leader | group.log, group.rows, group.snapshot | LEAN, SIDE |
| raft-snapshot | split-record | fence.table, group.log, issuer.table, srchi.marks | SPLIT, PD |
| raft-term-vote | fold-leader | group.leader | LEAN, SIDE |
| raft-term-vote | split-policy | group.leader | SPLIT, PD |
| raft-term-vote | split-record | group.leader | SPLIT, PD |
| range-table | route-forward | range.table | SPLIT, PD |
| range-table | split-policy | range.table | SPLIT, PD |
| read-lease | presence-rows | group.rows | PD, OBJ |
| slot-move | dedup-window | issuer.table, move.record | DRAFT, SLOG |
| slot-move | route-smart | move.record, slot.table | SRV, EMB-V8 |
| slot-table | route-smart | slot.table | SRV, EMB-V8 |
| split-policy | forks | meta.catalog | SPLIT, PD |
| split-record | caller-keys | fence.table, issuer.table | SPLIT, PD |
| split-record | consumer-groups | fence.table | SPLIT, PD |
| split-record | fold-all | group.rows | SPLIT, PD |
| split-record | presence-rows | group.rows | SPLIT, PD |
| split-record | range-table | range.table, split.record | SPLIT, PD |
| split-record | route-forward | range.table | SPLIT, PD |
| split-record | split-policy | load.report, range.table | SPLIT, PD |
| split-record | srchi-marks | srchi.marks | SPLIT, PD |
| writer-time | controller-sessions | link.clocks | ISR, SLOG |
| admission-credits | leader-epoch | group.leader | ISR |
| admission-credits | obj-writer-lease | group.leader | OBJ |
| admission-credits | writer-epoch-slog | group.leader | SLOG |
| caller-keys | leader-calls | key.table | SIDE |
| caller-keys | outside-log | outside.log | BUY |
| caller-keys | timestamp-oracle | time.writer | PD |
| client-sessions | obj-log | group.commit | OBJ |
| closed-timestamps | mvcc | closed.ts | PD |
| closed-timestamps | timestamp-oracle | tso.high | PD |
| closed-timestamps | two-phase-commit | txn.intents | PD |
| controller-commands | high-watermark | group.commit | ISR |
| controller-commands | isr-log | group.log | ISR |
| controller-commands | leader-epoch | group.leader, group.log | ISR |
| controller-commands | loglet | group.commit, group.log | SLOG |
| controller-commands | loglet-seal | group.log | SLOG |
| controller-commands | merge-record | meta.commands, meta.directory | PD |
| controller-commands | obj-log | group.commit, group.log | OBJ |
| controller-commands | obj-writer-lease | group.leader | OBJ |
| controller-commands | writer-epoch-slog | group.leader, group.learners | SLOG |
| controller-sessions | eligible-leaders | member.session | ISR |
| controller-sessions | isr-set | member.session | ISR |
| controller-sessions | leader-epoch | member.session | ISR |
| dedup-window | loglet | group.commit | SLOG |
| dedup-window | v4-ring | v4.owner | V4 |
| disk-incarnation | loglet | durable.log | SLOG |
| dormant-groups | loglet | durable.log, group.commit | SLOG |
| dormant-groups | rekey | meta.directory | CELL |
| fence-tokens | outside-log | outside.log | BUY |
| fold-all | high-watermark | group.commit | ISR |
| fold-all | isr-log | group.log | ISR |
| fold-all | leader-epoch | group.log | ISR |
| fold-all | loglet | group.commit, group.log | SLOG |
| fold-all | loglet-seal | group.log | SLOG |
| fold-all | outside-log | outside.log | BUY |
| fold-all | read-lease | group.rows | PD |
| fold-all | v4-stamps | v4.stamps | V4 |
| fold-all | writer-epoch-rlog | group.rows | RLOG |
| fold-lazy | fold-version | fold.version | OBJ |
| fold-lazy | obj-log | group.commit, group.log | OBJ |
| fold-lazy | obj-manifest | group.rows, group.snapshot | OBJ |
| fold-lazy | presence-rows | group.rows | OBJ |
| fold-lazy | read-lease | group.rows | OBJ |
| fold-lazy | subscribe | group.rows | OBJ |
| fold-leader | fold-lazy | group.rows | OBJ |
| fold-leader | obj-log | group.commit, group.log | OBJ |
| fold-leader | obj-manifest | group.rows, group.snapshot | OBJ |
| fold-leader | obj-writer-lease | group.leader | OBJ |
| fold-leader | read-lease | group.rows | OBJ |
| fold-version | outside-log | outside.log | BUY |
| healing-self | rekey | meta.catalog | CELL |
| high-watermark | eligible-leaders | group.commit | ISR |
| high-watermark | leader-epoch | group.leader, group.log | ISR |
| isr-log | high-watermark | group.log | ISR |
| isr-log | isr-set | group.log | ISR |
| isr-log | leader-epoch | group.leader, group.log, isr.leader-epoch | ISR |
| isr-set | eligible-leaders | isr.set | ISR |
| isr-set | high-watermark | group.commit, isr.set | ISR |
| isr-set | leader-epoch | group.leader, group.log, isr.leader-epoch, isr.set | ISR |
| ktxn-coordinator | forks | meta.directory | ISR |
| ktxn-coordinator | high-watermark | group.commit | ISR |
| ktxn-coordinator | ktxn-markers | txn.log | ISR |
| ktxn-markers | high-watermark | group.commit | ISR |
| ktxn-markers | isr-log | group.log | ISR |
| ktxn-markers | leader-epoch | group.log | ISR |
| lanes | forks | meta.catalog | LANE |
| lanes | route-forward | lane.map | LANE |
| leader-calls | forks | meta.directory | SIDE |
| leader-epoch | eligible-leaders | isr.elr | ISR |
| learners | loglet | group.commit, group.log | SLOG |
| learners | loglet-seal | group.log | SLOG |
| learners | writer-epoch-slog | group.learners | SLOG |
| lineage | consumer-groups | sub.cursor | SPLIT |
| lineage | srchi-marks | sub.cursor | SPLIT |
| lineage | subscribe | sub.cursor | SPLIT |
| link-pings | writer-epoch-rlog | link.ping | RLOG |
| lock-rows | outside-log | outside.log | BUY |
| log-replicas | move-policy | group.config | DRAFT |
| log-replicas | slot-move | group.config | DRAFT |
| loglet | dir-lease | durable.log | SLOG |
| loglet | input-recorder | durable.log | SLOG |
| loglet | loglet-chain | group.commit, group.log, loglet.chain | SLOG |
| loglet | loglet-seal | group.log, loglet.seal | SLOG |
| loglet | writer-epoch-slog | writer.epoch | SLOG |
| loglet-chain | writer-epoch-slog | loglet.chain | SLOG |
| loglet-seal | controller-sessions | member.session | SLOG |
| loglet-seal | loglet-chain | group.log, loglet.chain, loglet.seal | SLOG |
| loglet-seal | writer-epoch-slog | writer.epoch | SLOG |
| lsm-store | input-recorder | durable.log | PD |
| lsm-store | worker-map | durable.log | PD |
| merge-record | fold-all | group.rows | PD |
| merge-record | forks | meta.directory | PD |
| merge-record | presence-rows | group.rows | PD |
| merge-record | range-table | merge.record, range.table | PD |
| merge-record | route-forward | meta.directory, range.table | PD |
| merge-record | route-smart | meta.directory, range.table | PD |
| merge-record | split-policy | range.table | PD |
| merge-record | subscribe | meta.directory | PD |
| merge-record | two-phase-commit | range.table | PD |
| merge-record | worker-map | meta.directory | PD |
| meta-catalog | ktxn-coordinator | meta.directory | ISR |
| meta-catalog | lanes | meta.catalog | LANE |
| meta-catalog | leader-calls | meta.directory, slot.table | SIDE |
| meta-catalog | merge-record | meta.directory | PD |
| meta-catalog | rekey | meta.catalog, meta.directory | CELL |
| meta-directory | ktxn-coordinator | meta.directory | ISR |
| meta-directory | leader-calls | meta.directory | SIDE |
| meta-directory | leader-epoch | group.leader | ISR |
| meta-directory | merge-record | meta.directory | PD |
| meta-directory | obj-manifest | store.objects | OBJ |
| meta-directory | obj-writer-lease | group.leader | OBJ |
| meta-directory | rekey | meta.directory | CELL |
| meta-directory | writer-epoch-slog | group.leader | SLOG |
| meta-members | loglet-chain | meta.members | SLOG |
| meta-members | writer-epoch-rlog | meta.members | RLOG |
| meta-members | writer-epoch-slog | meta.members | SLOG |
| move-policy | leader-calls | meta.directory | SIDE |
| move-policy | obj-writer-lease | group.leader | OBJ |
| move-policy | writer-epoch-slog | group.leader | SLOG |
| mvcc | lsm-store | mvcc.versions | PD |
| none-rung | outside-log | outside.log | BUY |
| obj-log | input-recorder | durable.log | OBJ |
| obj-log | obj-manifest | group.log, store.manifest | OBJ |
| obj-log | obj-writer-lease | store.manifest, writer.epoch | OBJ |
| obj-manifest | forks | group.snapshot, store.objects | OBJ |
| obj-manifest | obj-writer-lease | store.manifest | OBJ |
| obj-manifest | presence-rows | group.rows | OBJ |
| producer-state | high-watermark | group.commit | ISR |
| producer-state | ktxn-coordinator | producer.table | ISR |
| producer-state | route-forward | route.inflight | ISR |
| producer-state | writer-time | time.writer | ISR |
| project-groups | memory-rung | group.class | COMP |
| raft-commit | closed-timestamps | group.commit | PD |
| raft-commit | eligible-leaders | group.commit | ISR |
| raft-commit | high-watermark | group.commit | ISR |
| raft-commit | isr-log | group.log | ISR |
| raft-commit | isr-set | group.commit | ISR |
| raft-commit | ktxn-coordinator | group.commit | ISR |
| raft-commit | ktxn-markers | group.commit | ISR |
| raft-commit | leader-epoch | group.leader, group.log | ISR |
| raft-commit | loglet | durable.log, group.commit, group.log | SLOG |
| raft-commit | loglet-chain | group.commit | SLOG |
| raft-commit | loglet-seal | group.log | SLOG |
| raft-commit | lsm-store | durable.log | PD |
| raft-commit | merge-record | group.commit | PD |
| raft-commit | mvcc | group.commit | PD |
| raft-commit | producer-state | group.commit | ISR |
| raft-commit | read-lease | group.commit | PD |
| raft-commit | rekey | group.commit | CELL |
| raft-commit | side-seam | group.commit | SIDE |
| raft-commit | wal-per-group | durable.log | ISR |
| raft-commit | writer-epoch-rlog | group.commit | RLOG |
| raft-commit | writer-epoch-slog | group.leader | SLOG |
| raft-config | high-watermark | group.commit | ISR |
| raft-config | isr-log | group.log | ISR |
| raft-config | leader-epoch | group.leader, group.log | ISR |
| raft-config | loglet | group.commit, group.log | SLOG |
| raft-config | loglet-seal | group.log | SLOG |
| raft-config | writer-epoch-slog | group.leader | SLOG |
| raft-leader-transfer | high-watermark | group.commit | ISR |
| raft-leader-transfer | isr-log | group.log | ISR |
| raft-leader-transfer | leader-calls | group.transfer | SIDE |
| raft-leader-transfer | leader-epoch | group.leader, group.log | ISR |
| raft-leader-transfer | loglet | group.commit, group.log | SLOG |
| raft-leader-transfer | loglet-seal | group.log | SLOG |
| raft-leader-transfer | writer-epoch-slog | group.leader | SLOG |
| raft-log | high-watermark | group.log | ISR |
| raft-log | isr-log | group.log | ISR |
| raft-log | isr-set | group.log | ISR |
| raft-log | ktxn-markers | group.log | ISR |
| raft-log | leader-epoch | group.leader, group.log | ISR |
| raft-log | loglet | group.log | SLOG |
| raft-log | loglet-chain | group.log | SLOG |
| raft-log | loglet-seal | group.log | SLOG |
| raft-log | lsm-store | group.log | PD |
| raft-log | merge-record | group.log | PD |
| raft-log | rekey | group.log | CELL |
| raft-log | side-seam | group.log | SIDE |
| raft-log | wal-per-group | group.log | ISR |
| raft-log | writer-epoch-rlog | group.log | RLOG |
| raft-log | writer-epoch-slog | group.leader | SLOG |
| raft-prevote-checkquorum | closed-timestamps | group.leader | PD |
| raft-prevote-checkquorum | high-watermark | group.leader | ISR |
| raft-prevote-checkquorum | isr-log | group.leader, group.log | ISR |
| raft-prevote-checkquorum | isr-set | group.leader | ISR |
| raft-prevote-checkquorum | leader-calls | group.leader | SIDE |
| raft-prevote-checkquorum | leader-epoch | group.leader, group.log | ISR |
| raft-prevote-checkquorum | loglet | group.log | SLOG |
| raft-prevote-checkquorum | loglet-seal | group.log | SLOG |
| raft-prevote-checkquorum | merge-record | group.leader | PD |
| raft-prevote-checkquorum | read-lease | group.contact, group.leader | PD |
| raft-prevote-checkquorum | rekey | group.leader | CELL |
| raft-prevote-checkquorum | side-seam | group.leader | SIDE |
| raft-prevote-checkquorum | timestamp-oracle | group.leader | PD |
| raft-prevote-checkquorum | two-phase-commit | group.leader | PD |
| raft-prevote-checkquorum | writer-epoch-rlog | group.leader | RLOG |
| raft-prevote-checkquorum | writer-epoch-slog | group.leader | SLOG |
| raft-snapshot | high-watermark | group.commit, group.log | ISR |
| raft-snapshot | isr-log | group.log | ISR |
| raft-snapshot | isr-set | group.log | ISR |
| raft-snapshot | ktxn-markers | group.log | ISR |
| raft-snapshot | leader-epoch | group.log | ISR |
| raft-snapshot | loglet | group.commit, group.log | SLOG |
| raft-snapshot | loglet-chain | group.log | SLOG |
| raft-snapshot | loglet-seal | group.log | SLOG |
| raft-snapshot | lsm-store | group.log | PD |
| raft-snapshot | merge-record | group.log | PD |
| raft-snapshot | rekey | fence.table, group.log, session.table, srchi.marks | CELL |
| raft-snapshot | side-seam | group.log | SIDE |
| raft-snapshot | wal-per-group | group.log | ISR |
| raft-snapshot | writer-epoch-rlog | group.log | RLOG |
| raft-term-vote | closed-timestamps | group.leader | PD |
| raft-term-vote | high-watermark | group.commit, group.leader | ISR |
| raft-term-vote | isr-log | group.leader, group.log | ISR |
| raft-term-vote | isr-set | group.leader | ISR |
| raft-term-vote | leader-calls | group.leader | SIDE |
| raft-term-vote | leader-epoch | group.leader, group.log | ISR |
| raft-term-vote | loglet | durable.log, group.commit, group.log | SLOG |
| raft-term-vote | loglet-seal | group.log | SLOG |
| raft-term-vote | lsm-store | durable.log, group.term-vote | PD |
| raft-term-vote | merge-record | group.leader | PD |
| raft-term-vote | read-lease | group.leader, group.term-vote | PD |
| raft-term-vote | rekey | group.leader | CELL |
| raft-term-vote | side-seam | group.leader | SIDE |
| raft-term-vote | timestamp-oracle | group.leader | PD |
| raft-term-vote | two-phase-commit | group.leader | PD |
| raft-term-vote | wal-per-group | durable.log | ISR |
| raft-term-vote | writer-epoch-rlog | group.leader | RLOG |
| raft-term-vote | writer-epoch-slog | group.leader | SLOG |
| range-table | lineage | range.table | SPLIT |
| range-table | route-smart | range.table | PD |
| range-table | two-phase-commit | range.table | PD |
| read-lease | obj-log | group.commit | OBJ |
| read-lease | obj-writer-lease | group.leader, writer.epoch | OBJ |
| rekey | caller-keys | fence.table, session.table | CELL |
| rekey | client-sessions | session.table | CELL |
| rekey | consumer-groups | fence.table, sub.cursor | CELL |
| rekey | fence-tokens | fence.table | CELL |
| rekey | fold-all | group.rows | CELL |
| rekey | forks | meta.catalog, meta.directory | CELL |
| rekey | memory-rung | meta.catalog | CELL |
| rekey | none-rung | meta.catalog | CELL |
| rekey | presence-rows | group.rows | CELL |
| rekey | restore-mark | session.table | CELL |
| rekey | route-forward | meta.directory | CELL |
| rekey | saga-intents | fence.table, session.table | CELL |
| rekey | srchi-marks | srchi.marks, sub.cursor | CELL |
| rekey | subscribe | meta.directory, sub.cursor | CELL |
| rekey | tier | meta.catalog | CELL |
| restore-mark | obj-manifest | store.objects | OBJ |
| route-forward | leader-epoch | group.leader | ISR |
| route-forward | obj-writer-lease | group.leader, writer.epoch | OBJ |
| route-forward | v4-ring | v4.owner | V4 |
| route-forward | writer-epoch-rlog | writer.epoch | RLOG |
| route-forward | writer-epoch-slog | group.leader, writer.epoch | SLOG |
| route-smart | leader-epoch | group.leader | ISR |
| saga-intents | outside-log | outside.log | BUY |
| slot-move | fold-lazy | group.rows | OBJ |
| slot-move | leader-calls | slot.table | SIDE |
| slot-move | loglet | group.commit, group.log | SLOG |
| slot-move | loglet-seal | group.log | SLOG |
| slot-move | obj-log | group.commit, group.log | OBJ |
| slot-move | obj-manifest | store.objects | OBJ |
| slot-move | obj-writer-lease | group.leader | OBJ |
| slot-move | writer-epoch-slog | group.leader | SLOG |
| slot-sequence | obj-writer-lease | group.leader, writer.epoch | OBJ |
| slot-sequence | writer-epoch-rlog | writer.epoch | RLOG |
| slot-sequence | writer-epoch-slog | group.leader, writer.epoch | SLOG |
| slot-table | leader-calls | slot.table | SIDE |
| slow-leader-controller | controller-sessions | member.session | PD |
| slow-leader-controller | leader-calls | group.transfer | SIDE |
| split-record | dedup-window | issuer.table | SPLIT |
| split-record | fence-tokens | fence.table | SPLIT |
| split-record | lineage | range.table, split.record | SPLIT |
| split-record | merge-record | range.table | PD |
| split-record | route-smart | range.table | PD |
| split-record | saga-intents | fence.table, issuer.table | SPLIT |
| split-record | two-phase-commit | range.table | PD |
| srchi-marks | outside-log | outside.log | BUY |
| subscribe | high-watermark | group.commit | ISR |
| subscribe | isr-log | group.log | ISR |
| subscribe | leader-epoch | group.log | ISR |
| subscribe | loglet | group.commit, group.log | SLOG |
| subscribe | loglet-seal | group.log | SLOG |
| subscribe | obj-log | group.commit, group.log | OBJ |
| subscribe | obj-manifest | group.snapshot, store.objects | OBJ |
| tenant-budget | loglet | durable.log | SLOG |
| tenant-budget | obj-log | durable.log | OBJ |
| tier | isr-log | group.log | ISR |
| tier | leader-epoch | group.leader, group.log | ISR |
| tier | loglet | durable.log, group.log | SLOG |
| tier | loglet-seal | group.log | SLOG |
| tier | writer-epoch-slog | group.leader | SLOG |
| timestamp-oracle | consumer-groups | time.writer | PD |
| timestamp-oracle | lock-rows | time.writer | PD |
| timestamp-oracle | mvcc | tso.high | PD |
| timestamp-oracle | presence-rows | time.writer | PD |
| timestamp-oracle | queue-claims | time.writer | PD |
| timestamp-oracle | two-phase-commit | tso.high | PD |
| two-phase-commit | lsm-store | mvcc.versions | PD |
| two-phase-commit | mvcc | mvcc.versions, txn.intents | PD |
| v4-digests | v4-feed-words | v4.digests | V4 |
| v4-digests | v4-floors | v4.floors | V4 |
| v4-digests | v4-frontiers | v4.lanes | V4 |
| v4-digests | v4-sheds | v4.sheds | V4 |
| v4-floors | v4-confirm-ladder | v4.floors | V4 |
| v4-frontiers | v4-confirm-ladder | v4.lanes | V4 |
| v4-frontiers | v4-floors | v4.floors, v4.lanes | V4 |
| v4-frontiers | v4-teachers | v4.lanes | V4 |
| v4-frontiers | v4-views | v4.views | V4 |
| v4-lanes | v4-confirm-ladder | v4.lanes | V4 |
| v4-lanes | v4-digests | v4.lanes | V4 |
| v4-lanes | v4-floors | v4.lanes | V4 |
| v4-lanes | v4-frontiers | v4.lanes | V4 |
| v4-lanes | v4-ring | v4.owner | V4 |
| v4-lanes | v4-stamps | v4.lanes | V4 |
| v4-lanes | v4-teachers | v4.lanes | V4 |
| v4-lanes | v4-views | v4.views | V4 |
| v4-latches | v4-feed-words | v4.latches | V4 |
| v4-latches | v4-teachers | v4.latches | V4 |
| v4-latches | v4-views | v4.views | V4 |
| v4-orphans | v4-latches | v4.orphans | V4 |
| v4-orphans | v4-ring | v4.owner | V4 |
| v4-orphans | v4-sheds | v4.orphans | V4 |
| v4-orphans | v4-teachers | v4.teachers | V4 |
| v4-orphans | v4-views | v4.views | V4 |
| v4-sheds | v4-feed-words | v4.sheds | V4 |
| v4-sheds | v4-floors | v4.floors | V4 |
| v4-sheds | v4-views | v4.views | V4 |
| v4-stamps | v4-frontiers | v4.lanes | V4 |
| v4-stamps | v4-tombstones | v4.stamps | V4 |
| v4-stamps | v4-views | v4.views | V4 |
| v4-teachers | v4-floors | v4.teachers | V4 |
| v4-tombstones | v4-floors | v4.floors | V4 |
| v4-tombstones | v4-frontiers | v4.tombstones | V4 |
| v4-tombstones | v4-teachers | v4.tombstones | V4 |
| v4-views | v4-ring | v4.views | V4 |
| wal-per-group | dir-lease | durable.log | ISR |
| wal-per-group | input-recorder | durable.log | ISR |
| wal-per-group | isr-log | group.log | ISR |
| wal-per-group | leader-epoch | group.log | ISR |
| wal-per-group | tier | durable.log | ISR |
| wal-per-group | v4-confirm-ladder | durable.log | V4 |
| wal-per-group | v4-floors | durable.log | V4 |
| wal-per-group | v4-frontiers | v4.lanes | V4 |
| wal-per-group | v4-lanes | v4.lanes | V4 |
| writer-epoch-rlog | presence-rows | group.rows | RLOG |
| writer-epoch-slog | controller-sessions | member.session | SLOG |
| writer-judging | fold-lazy | group.rows | OBJ |
| writer-judging | high-watermark | group.commit | ISR |
| writer-judging | isr-log | group.log | ISR |
| writer-judging | leader-epoch | group.leader, group.log | ISR |
| writer-judging | loglet | group.commit, group.log | SLOG |
| writer-judging | loglet-seal | group.log | SLOG |
| writer-judging | obj-log | group.commit, group.log | OBJ |
| writer-judging | obj-writer-lease | group.leader, writer.epoch | OBJ |
| writer-judging | producer-state | writer.logend | ISR |
| writer-judging | two-phase-commit | writer.logend | PD |
| writer-judging | v4-ring | v4.owner | V4 |
| writer-judging | writer-epoch-rlog | writer.epoch | RLOG |
| writer-judging | writer-epoch-slog | group.leader, writer.epoch | SLOG |
| writer-time | fold-lazy | group.rows | OBJ |
| writer-time | leader-epoch | group.leader | ISR |
| writer-time | obj-writer-lease | group.leader, writer.epoch | OBJ |
| writer-time | writer-epoch-rlog | writer.epoch | RLOG |
| writer-time | writer-epoch-slog | group.leader, writer.epoch | SLOG |
