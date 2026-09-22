# 22 · A story worth scrubbing

Terminal 1, one run: three members in one process, three acts, and a capture file at the end:

```
$ cd examples/22-time-travel
$ node story.ts
race: 'from a' is a:1, 'from b' is b:1 → hot is 'from b' on a, b, c
history: 'a again' is b:3, 'b again' is b:2 → hot is 'a again' on a, b, c
cut: a dropped its link to c, 'the cut' is c:4 → during is 'the cut' on a, b, c
open it: npm run debug -- examples/22-time-travel/story.capture.json
```

Terminal 2, from the repo root — the debugger over that file, at `http://localhost:4699/debug`:

```
$ npm run debug -- examples/22-time-travel/story.capture.json

> fero@4.0.0 debug
> node --experimental-strip-types --no-warnings tools/debug/serve.ts examples/22-time-travel/story.capture.json

fero v3 → http://localhost:4699/  (capture: examples/22-time-travel/story.capture.json)
  dashboard http://localhost:4699/scenarios · debugger http://localhost:4699/debug
```

- Contention is elections, not history. Before the first view every member stamps for itself, so `a` and
  `b` both stamp `hot` with seq 1 and each member holds an election for the cell: the higher id wins the
  tie, and a member that already held `b`'s write sets `a`'s aside (`lwwSkip` in its journal). All three
  agree. Once the view forms one member owns each cell — `b` owns `hot` — and stamps every write to it in
  turn, `b:2` then `b:3`: the same two writes are plain history, no election. Then `a` drops its socket to
  `c`, and `c`'s write still reaches `a`: the link dies (`linkDown`), comes back (`redial`), and the
  digest exchange ships what `a` missed (`aeShip`). Anti-entropy heals a cut, and the three agree again.
- The box at the top of the viewer filters the whole tree: `write:lww-lost` is the one write that lost a
  tie (`a#1`), `is:warn` adds the cell it contested (`hot`), `kind:linkDown` is the two ends of the cut
  (`a` and `c`), `kind:aeShip` is every member (anti-entropy also ran when they first met), and `is:crit`
  finds nothing: the bar at the bottom says `converged ✓ · replay ✓`. Drag the slider at the bottom left
  to rewind every member's journal to a step and see what each held then: one key until the cut lands.

```sh
node story.ts --fero.heartbeat.ms 100   # sooner: the first view and each stop wait on a heartbeat
node story.ts --fero.redial.ms 1000     # a slower redial: the cut stays open longer, the story waits for it
node story.ts --fero.journal.cap 16     # a ring too small: the viewer says truncated, replay ✗, slider off
for i in 1 2 3; do node story.ts; done  # the same stamps every run: the shape decides them, not luck
```

`node check.ts` runs this story on its own and ends with `ok 22-time-travel`, in about three seconds.
Next: [23 · watch it live](../23-live/).
