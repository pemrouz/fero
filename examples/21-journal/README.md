# 21 · Tail the kernel's diary

Terminal 1:

```
$ cd examples/21-journal
$ node server.ts
pid 225833
    0 start
    1 writeLocal 1 225833
    2 dial 127.0.0.1:41757
    3 linkUp 1 1
    4 linkUp 2 0
    5 identified 1 d977cc5f
    7 dupLink 2 1
    8 linkDown 2 close
    9 applyInbound d977cc5f 1
   11 aeShip d977cc5f 1
   14 propose 1 2
   16 viewInstall 1 2
   23 leave d977cc5f
   24 propose 2 1
   25 evict d977cc5f
   26 viewInstall 2 1
   27 linkDown 1 close
```

Terminal 2, the same command — Ctrl-C it:

```
$ node server.ts
pid 225910
    0 start
    1 writeLocal 1 225910
    2 dial 127.0.0.1:42385
    3 linkUp 2 0
    4 linkUp 1 1
    5 identified 1 9bc02bcd
    6 dupLink 1 2
    7 identified 2 9bc02bcd
    9 aeShip 9bc02bcd 1
   11 linkDown 1 close
   12 applyInbound 9bc02bcd 1
   15 vote 1 1
   16 viewInstall 1 2
^C
```

- `diag(f).journal(from)` is a cursor over the kernel's one diagnostics ring — the events the debug viewer
  shows. Every 250 ms the tail prints what landed since the cursor: `t` (the event's number), the kind as a
  name from `JK`, then `a` and `b` as they are (what they mean is per kind: kernel/journal.ts). The
  heartbeat's three kinds (`ping`, `digestOut`, `digestIn`: three lines every 500 ms) are left out, which is
  why `t` skips.
- Terminal 2 arrives: `dial`, `linkUp`, `identified` with its id. Both dialed at once, so one link is kept
  (`dupLink`). The copy with the lower id opens one digest exchange, and each ships the other the row it
  lacks (`aeShip`; `applyInbound` on the other side), so each row arrives once. In a dial race a second
  `aeShip` can go down the link that is closing; it never arrives (no `dupDrop`). A ballot (`propose`,
  `vote`) ends in `viewInstall 1 2`: epoch 1, two members.
- Ctrl-C is a leave by vote: `leave` asks for the view without it (when the leaving copy has the lower id
  it proposes that view itself, and the survivor logs `vote 2 1` instead), `evict` and `viewInstall 2 1`
  grant it, and only then does the socket close: `linkDown 1 close`. The ring holds the last 4096 events;
  a tail that falls behind says how many it missed.

```sh
node server.ts                      # terminal 2 again: terminal 1 logs a fresh identified, viewInstall 3 2
node server.ts                      # a third terminal: identified again, then a view of three
node server.ts --fero.journal.cap 8 # a ring of 8: the join burst overflows it; the tail says what it missed
kill -9 <pid>                       # a crash, not a leave: linkDown at once, gateClose minority, suspect
                                    # one of two is a minority: nobody is voted in — Ctrl-C it, start over
```

`node check.ts` runs this story, restart too, on its own and ends with `ok 21-journal` in about six seconds.
Next: [22 · a story worth scrubbing](../22-time-travel/).
