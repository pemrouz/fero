# 23 · Watch it live

Terminal 1 — three servers in one process, and a capture file rewritten once a second:

```
$ cd examples/23-live
$ node live.ts
pid 297581
capture 1 — journal 89 — 3 rows
capture 2 — journal 135 — 6 rows
capture 3 — journal 172 — 6 rows
capture 4 — journal 225 — 6 rows
capture 5 — journal 272 — 6 rows
capture 6 — journal 317 — 6 rows
capture 7 — journal 370 — 6 rows
capture 8 — journal 415 — 6 rows
capture 9 — journal 460 — 6 rows
capture 10 — journal 529 — 6 rows
^C
```

Terminal 2, once `capture 1` is there — then open the debugger link:

```
$ npm run debug -- examples/23-live/live.capture.json

> fero@4.0.0 debug
> node --experimental-strip-types --no-warnings tools/debug/serve.ts examples/23-live/live.capture.json

fero v3 → http://localhost:4699/  (capture: examples/23-live/live.capture.json)
  dashboard http://localhost:4699/scenarios · debugger http://localhost:4699/debug
^C
```

- `diag(f).capture()` is one node's slice in the debugger's own format: its journal (the kernel's event
  log), its logs, its state and a hash of it. `live.ts` writes the three slices as one file marked
  `kind: 'live'`, and that word is what makes the viewer poll the file every 1.5 s. The write goes to a temp
  file first and is renamed in, so a poll never reads half a file. No wire, no attach: the file is the feed.
- What moves: the writer rotates, so most writes are forwarded to the row's owner, and the Writes tree
  grows by three a second, one row per write; the six rows under Cells are rewritten; `replay ✓` says the
  journal replays to the state it came with. Drag the scrubber and the polling pauses; reset it and it
  goes on. The call raises `journal.cap`, each node's event ring (4096 by default, about four minutes at
  this rate), so the whole run stays scrubbable: once a ring drops an event the scrubber goes off.
- A capture is one moment. One taken while a write is still on its way paints `diverged ✗` in red (the
  three do not agree yet) and the next poll paints it green again — rare here, and not a lost write. After
  Ctrl-C the last file is often written while the three leave, so it can stay red; run again, it is green.

```sh
node live.ts --fero.journal.cap 64   # 64-event rings: the count stops at 192, drops counted, scrubbing off
npm run debug -- --live --nodes 3    # no file at all: the debug server holds three nodes of its own
```

`node check.ts` runs this story on its own and ends with `ok 23-live`, in about five seconds.
Next: [30 · chaos, then audit](../30-fleet-audit/).
