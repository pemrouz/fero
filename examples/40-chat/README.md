# 40 · Chat rooms

Terminal 1, the room. Its screen is the count and the last line, redrawn on every message:

```
$ cd examples/40-chat
$ node room.ts general
ROOM general 395003 — messages 2
16:44:02 <bob> hi ada
```

Terminal 2, ada typed `hello`, then a 300-character line — the reply came back under it:

```
$ node join.ts general ada
CHAT general — ada 395143
16:44:01 <ada> hello
16:44:02 <bob> hi ada
! methods.post: too long
```

Terminal 3, bob typed `hi ada`:

```
$ node join.ts general bob
CHAT general — bob 395242
16:44:01 <ada> hello
16:44:02 <bob> hi ada
```

- `fero('chat-general', { dir, methods: { post } })` is the room. A message is a NEW row, written by `post`
  on the server: the caller says a nick and a text, the server adds `at` from its own clock and `from` —
  `ctx.peer`, the caller's id, the one thing a caller cannot claim. Declaring `methods:` is the door: a
  joiner's own write is refused `methods-only`. A rule a caller must hear is thrown: `too long` comes back
  as `methods.post: too long`.
- The server orders nothing. Every screen sorts the rows itself, `f.data.az((a, b) => a.at - b.at || …)`:
  by time, and by `from` when two posts share a millisecond. Left to a tie, the order would be the order
  the rows reached that screen, and a second room server can feed its joiners in another order. With
  the tiebreak the order comes from the rows alone, the same on every screen.
- Facts only: nothing is edited, nothing is removed, and nobody's presence is a row. The room grows by one
  row per line, forever, and `./room-general` keeps every row across a restart — a `prune` method that
  deletes old rows is the recipe when it must shrink (30). Ctrl-C the room and a line typed meanwhile is a
  call with nobody to run it: `! methods.post: timeout after 10000ms` ten seconds later, where a plain
  write would wait (03).

```sh
node join.ts general cy                    # a third joiner: the same lines in the same order
node bot.ts general bot 5                  # a scripted joiner: five lines, and it leaves once it sees them
node room.ts random                        # another room is another resource: chat-random, in ./room-random
node room.ts general --fero.dir ./room-b   # a second server for the same room: its own log, the same lines
```

`node check.ts` runs the room and two bots on its own and ends with `ok 40-chat`, in about five seconds.
Next: [41 · a kanban board](../41-kanban/).
