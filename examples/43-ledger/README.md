# 43 · A ledger that survives

Terminals 1 to 3, one member each; 4 the notifier; 5 a teller. Terminal 2 over two runs — after the teller's
second run, then `kill -9 463595` from terminal 5 (the pid is on its screen), and the same command once
`members 2` shows on terminal 1:

```
$ cd examples/43-ledger
$ node member.ts 4902
MEMBER 463595 on 127.0.0.1:4902 — life 7adc0e79
epoch 2 — members 3 — peers 3 — writable true
rows 3 — { mint: -100, alice: 90, bob: 10 }
$ node member.ts 4902
MEMBER 464569 on 127.0.0.1:4902 — life 7adc0e79~2
epoch 4 — members 3 — peers 3 — writable true
rows 4 — { mint: -100, alice: 85, bob: 15 }
```

Terminal 5, four runs — the last two while 4902 is dead:

```
$ node teller.ts mint alice 100
TELLER 463810
f25d1952 { mint: -100, alice: 100 }
$ node teller.ts alice bob 5 2
TELLER 463881
75b056a3 { mint: -100, alice: 95, bob: 5 }
5d58f286 { mint: -100, alice: 90, bob: 10 }
$ node teller.ts bob alice 50
TELLER 464379
methods.transfer: insufficient funds { mint: -100, alice: 90, bob: 10 }
$ node teller.ts alice bob 5
TELLER 464451
6a924243 { mint: -100, alice: 85, bob: 15 }
```

```
$ node notifier.ts
NOTIFIER 463719
n-f25d1952 → alice 100 — cleared
n-75b056a3 → bob 5 — cleared
n-5d58f286 → bob 5 — cleared
n-6a924243 → bob 5 — cleared
```

- `transfer` is the rule, thrown from the method: it folds the caller's balance from the rows the member
  holds, and the teller hears `insufficient funds`. `mint` alone may go below zero, so the balances sum to
  zero. The rule runs on the one member the teller reached: two tellers at once can both pass it (17).
- A transfer is one row and its intent rides in it: `outbox: { notify: to }` commits with the money. The
  notifier, a client of `ledger` and the server of `notices`, sees each row land, writes `n-<id>` (one cell
  per transfer: twice is the same notice) and clears the intent through `notified` — a method, the only
  way a client changes a row once `methods:` is declared (the door, 08). The row is rewritten without its
  `outbox`; the money on it is never edited.
- `kill -9` one member: the other two vote it out (`members 2`, about a second at redial 30) and keep
  committing. The same command is the same member in its next life (`~2`): its three rows back from its
  disk before it has reached anyone, then voted back in (`epoch 4 — members 3`) with the one it missed
  (`rows 4`).

```sh
node teller.ts mint bob 1000   # the one account the rule lets below zero: -1100, the sum still 0
node member.ts 4904            # a fourth member: members 4 on every screen, every row on it in a second
node notifier.ts               # a second one replays the log and delivers everything again: one cell each
```

`node check.ts` runs this story on its own and ends with `ok 43-ledger`, in about ten seconds.
That is the series.
