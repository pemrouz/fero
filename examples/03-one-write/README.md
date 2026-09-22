# 03 · One write

Terminal 1, alone — three notes written, and nothing has landed:

```
$ cd examples/03-one-write
$ node client.ts
CLIENT 1035262 — me 34efb3aa
["note-1"] pending
["note-2"] pending
["note-3"] pending
{}
```

Terminal 2, over two runs — the notes turn up here, carrying the times they were written:

```
$ node server.ts
SERVER 1035299 — me e69345ad — clients 1
{ 'note-1': '23:09:52', 'note-2': '23:09:54', 'note-3': '23:09:56' }
^C
$ node server.ts
SERVER 1035369 — me 12bb3ef2 — clients 1
{ 'note-7': '23:10:04', 'note-8': '23:10:06', 'note-9': '23:10:08' }
```

Terminal 1, the moment the first server stamped them:

```
CLIENT 1035262 — me 34efb3aa
["note-1"] committed by e69345ad
["note-2"] committed by e69345ad
["note-3"] committed by e69345ad
{ 'note-1': '23:09:52', 'note-2': '23:09:54', 'note-3': '23:09:56' }
```

- `fero('notes')` with nothing else is a client, and its assignment is a REQUEST: a `pending` row of
  `f.cluster.writes`, and nothing in its object. With no server up the request waits, as long as it takes.
  Nothing is lost, nothing is faked.
- A server stamps it — `committed by e69345ad`, the id on the server's own screen, not mine — and only then
  does the note show, on both screens at once. A write shows when it commits, never before.
- Ctrl-C the server and the next notes wait again. Run it again and it is a NEW server, a new `me` on a new
  port: it stamps what was waiting. It started empty, so the client takes its truth: notes 1 to 6 are gone
  from both screens, and the notes written while nothing was up land, carrying their times.

```sh
node server.ts --fero.dir ./notes   # the notes come back after a restart, and nothing is lost
node client.ts --fero.server        # the same file as a server: it stamps its own writes
```

`node check.ts` runs this story on its own and ends with `ok 03-one-write`, in about twenty seconds.
Next: [04 · rows and records](../04-rows/).
