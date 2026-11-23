# absent: pass 1 from the run cache

Design rules: 68 necessary alone, 44 not, 0 not run yet.

| Rule | Role | Dropped alone breaks |
|---|---|---|
| `stand.voter` | raft core | SN on o1 (10 steps) |
| `stand.go` | raft core | HF on solo (4 steps) |
| `vote.cand` | raft core | undecided (r1s: state limit) |
| `vote.term` | raft core | nothing breaks |
| `vote.once` | raft core | ES on s1f (12 steps) |
| `vote.log` | raft core | LC on s1f (12 steps) |
| `vote.grant` | raft core | DJ on r1 (4 steps) |
| `vote.count` | raft core | HF on r1 (2 steps) |
| `win.cand` | raft core | P9W on solo (13 steps) |
| `win.maj` | raft core | DJ on r1 (3 steps) |
| `win.lead` | raft core | P9W on solo (13 steps) |
| `win.noop` | raft core | HF on solo (4 steps) |
| `repl.term` | raft core | LW on o1f (15 steps) |
| `repl.copy` | raft core | HF on r1 (2 steps) |
| `repl.ci` | raft core | HF on o1 (1 steps) |
| `commit.own` | raft core | LW on o1f (12 steps) |
| `commit.maj` | raft core | NL on r1 (5 steps) |
| `commit.set` | raft core | HF on solo (4 steps) |
| `commit.down` | raft core | SN on o1 (7 steps) |
| `grow.leader` | raft | nothing breaks |
| `grow.idle` | raft | P9 on g0 (11 steps) |
| `grow.small` | grow | P9W on r1 (10 steps) |
| `grow.cand` | grow | nothing breaks |
| `grow.append` | grow | GF on g0 (0 steps) |
| `pick.leader` | raft | nothing breaks |
| `pick.idle` | raft | P9 on o1 (11 steps) |
| `pick.need` | heal | P9 on o1 (17 steps) |
| `pick.wait` | leave | nothing breaks |
| `pick.cand` | heal | nothing breaks |
| `pick.new` | heal | undecided (s1f: state limit) |
| `pick.notret` | heal | nothing breaks |
| `pick.append` | heal | HF on r1s (1 steps) |
| `add.leader` | raft | nothing breaks |
| `add.idle` | raft | P9 on o1d (16 steps) |
| `add.placed` | heal | nothing breaks |
| `add.new` | heal | P9W on r1 (10 steps) |
| `add.cand` | heal | P9 on o1f (23 steps) |
| `add.notret` | heal | P7 on o1 (12 steps) |
| `add.append` | heal | HF on r1s (1 steps) |
| `standby.leader` | raft | nothing breaks |
| `standby.idle` | raft | P9 on o1d (13 steps) |
| `standby.one` | grow | nothing breaks |
| `standby.new` | grow | P9 on o1 (17 steps) |
| `standby.cand` | grow | P9 on o1d (18 steps) |
| `standby.notret` | grow | P7 on o1 (4 steps) |
| `standby.append` | grow | HF on o1d (4 steps) |
| `promote.leader` | raft | nothing breaks |
| `promote.idle` | raft | B2B on g0 (10 steps) |
| `promote.learner` | heal | P9W on r1 (10 steps) |
| `promote.placed` | heal | nothing breaks |
| `promote.caught` | heal | nothing breaks |
| `promote.live` | heal | OL on g1 (10 steps) |
| `promote.notret` | heal | P7 on gr (10 steps) |
| `promote.odd` | heal | nothing breaks |
| `promote.pair` | grow | B2B on o1 (6 steps) |
| `promote.append` | heal | GF on g0 (0 steps) |
| `remove.leader` | raft | nothing breaks |
| `remove.idle` | raft | P9 on s1s (23 steps) |
| `remove.voter` | heal | nothing breaks |
| `remove.gone` | heal | P9 on r1s (31 steps) |
| `remove.four` | heal | CK on g1 (17 steps) |
| `remove.newok` | heal | nothing breaks |
| `remove.append` | heal | nothing breaks |
| `surplus.leader` | raft | nothing breaks |
| `surplus.idle` | raft | P9 on r1s (18 steps) |
| `surplus.voter` | heal | nothing breaks |
| `surplus.four` | heal | OL on o1 (5 steps) |
| `surplus.last` | heal | P9 on r1s (33 steps) |
| `surplus.allheld` | heal | nothing breaks |
| `surplus.append` | heal | HF on r1s (1 steps) |
| `dropl.leader` | raft | nothing breaks |
| `dropl.idle` | raft | P9 on o1 (13 steps) |
| `dropl.learner` | grow | P9 on o1 (21 steps) |
| `dropl.gone` | grow | P9 on o1 (17 steps) |
| `dropl.append` | grow | DL on o1d (1 steps) |
| `stepback.leader` | raft | nothing breaks |
| `stepback.idle` | raft | OV on o1f (11 steps) |
| `stepback.two` | grow | CK on g1 (16 steps) |
| `stepback.other` | grow | P9 on g1 (42 steps) |
| `stepback.few` | grow | B2B on g0 (11 steps) |
| `stepback.noret` | grow | P9 on o1 (22 steps) |
| `stepback.append` | grow | HF on o1f (6 steps) |
| `leave.mark` | leave | SF on o1 (1 steps) |
| `write.stay` | leave | LW on o1 (8 steps) |
| `handover.leader` | raft | nothing breaks |
| `handover.self` | leave | undecided (s1: state limit) |
| `handover.voter` | xfer | nothing breaks |
| `handover.tvoter` | xfer | SN on o1 (7 steps) |
| `handover.notret` | leave | LD on rl (3 steps) |
| `handover.caught` | xfer | LW on o1f (16 steps) |
| `handover.live` | xfer | P9L on o1f (14 steps) |
| `handover.transfer` | leave | nothing breaks |
| `opromote.leader` | raft | nothing breaks |
| `opromote.idle` | raft | P9 on o1 (10 steps) |
| `opromote.one` | leave | nothing breaks |
| `opromote.self` | leave | B2B on o1 (3 steps) |
| `opromote.learner` | leave | nothing breaks |
| `opromote.caught` | leave | nothing breaks |
| `opromote.live` | leave | OL on o1d (2 steps) |
| `opromote.notret` | leave | nothing breaks |
| `opromote.append` | leave | HF on o1 (1 steps) |
| `lrem.leader` | raft | nothing breaks |
| `lrem.idle` | raft | P9 on o1 (12 steps) |
| `lrem.voter` | leave | P9W on gr (40 steps) |
| `lrem.ret` | leave | P9 on gr (27 steps) |
| `lrem.maj` | leave | nothing breaks |
| `lrem.few` | leave | nothing breaks |
| `lrem.keep` | leave | nothing breaks |
| `lrem.newok` | leave | nothing breaks |
| `lrem.two` | leave | CK on r1 (2 steps) |
| `lrem.append` | leave | HF on o1 (1 steps) |
| `ldead.leader` | raft | nothing breaks |
| `ldead.idle` | raft | OV on o1f (8 steps) |
| `ldead.voter` | leave | P9 on o1d (19 steps) |
| `ldead.dead` | leave | P9 on o1 (23 steps) |
| `ldead.carry` | leave | CK on g1 (16 steps) |
| `ldead.maj` | leave | LW on s1f (7 steps) |
| `ldead.append` | leave | SF on s2 (2 steps) |
| `ldrop.leader` | raft | nothing breaks |
| `ldrop.idle` | raft | P9 on o1 (10 steps) |
| `ldrop.learner` | leave | P9 on o1 (18 steps) |
| `ldrop.leave` | leave | P9 on o1 (17 steps) |
| `ldrop.append` | leave | nothing breaks |
| `exit.unnamed` | leave | nothing breaks |
| `exit.nolead` | leave | nothing breaks |
| `exit.safe` | leave | LW on o1 (8 steps) |
| `exit.held` | leave | nothing breaks |
| `exitms.lms` | leave | nothing breaks |
| `exitms.safe` | leave | LW on o1 (9 steps) |
| `exitms.held` | leave | DX on s1 (6 steps) |
| `exitalone.lms` | leave | nothing breaks |
| `exitalone.alone` | leave | LX on o1 (3 steps) |
| `exitalone.stop` | leave | SF on solo (1 steps) |
