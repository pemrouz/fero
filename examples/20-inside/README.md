# 20 · Looking inside

Terminal 1, one run:

```
$ cd examples/20-inside
$ node inside.ts
journal 73 (0 dropped) · log 60 · confirms { api: 0, kernel: 0 } · served 0
compacted 55 entries; log now 5
open it:  npm run debug -- examples/20-inside/inside.capture.json
```

Terminal 2, the debugger on that file — then open http://localhost:4699/debug in a browser:

```
$ npm run debug -- examples/20-inside/inside.capture.json

> fero@4.0.0 debug
> node --experimental-strip-types --no-warnings tools/debug/serve.ts examples/20-inside/inside.capture.json

fero v4 → http://localhost:4699/  (capture: examples/20-inside/inside.capture.json)
  dashboard http://localhost:4699/scenarios · debugger http://localhost:4699/debug
^C
```

- `diag(f)`, from `internals`, is the diagnostics handle every instance carries off the typed surface: the
  ring of kernel events (`journal`: how many it holds, how many fell off), the entries the writes left in
  the logs (`log`), probes in flight (`confirms`), live subscriptions served (`served`). `compact()` forces
  the pass the heartbeat runs by size: below the frontier — what every member has provably applied — an
  entry that is no longer its cell's winner goes. Sixty writes to five cells leave five. A server that
  never met a peer never compacts: no view of members yet, so no frontier — this file holds two.
- `capture()` is one node's slice in the debugger's format; a file of slices plus the event vocabulary is
  the debugger's input, the same viewer a failed simulation opens. Its outline is Nodes (open one for its
  links and streams), Writes (every change, `author#ticket`), Cells (every field, its winning value and
  who wrote it) and Violations (only when there are any); hover a label for plain English; the box at the
  top filters the whole tree by a name or a facet. The bottom bar replays every journal into the captured
  end state (`replay ✓`) and compares the two fingerprints (`converged ✓`).
- The limits this series keeps. `fero()` has no `diag` key, so `npm run debug -- --attach` cannot reach a
  `fero()` process: a capture file is the public way in. Never capture a scoped cluster (`replicas`): the
  viewer paints `never-arrived` in red on members that were never meant to hold the row (an open bug in
  STATUS.md). A node that wrote after a restart from its `dir` replays fine; its links and streams stay
  `@ end`.

```sh
node inside.ts --fero.journal.cap 8   # a ring of eight: 65 events fall off; the viewer says replay ✗
npm run debug                         # no file: the debugger's own dashboard of simulated runs
npm run debug -- --port 4700 examples/20-inside/inside.capture.json   # the same file on another port
```

`node check.ts` runs this story on its own and ends with `ok 20-inside`, in about two seconds.
Next: [21 · tail the kernel's diary](../21-journal/).
