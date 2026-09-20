# 01 · One file, run it twice

Terminal 1:

```
$ cd examples/01-two-servers
$ node server.ts
pid 1034557
members 0 {}
members 0 { '1034557': 1 }
members 2 { '1034557': 2 }
members 2 { '1034557': 2, '1034577': 1 }
members 1 { '1034557': 3, '1034577': 1 }
members 1 { '1034557': 4, '1034577': 1 }
members 1 { '1034557': 5, '1034577': 1 }
members 2 { '1034557': 5, '1034577': 1, '1034596': 1 }
```

Terminal 2, the same command — Ctrl-C it, and run it again:

```
$ node server.ts
pid 1034577
members 0 {}
members 0 { '1034557': 1 }
members 2 { '1034557': 2 }
members 2 { '1034557': 2, '1034577': 1 }
^C
$ node server.ts
pid 1034596
members 0 {}
members 0 { '1034557': 1 }
members 0 { '1034557': 2 }
members 0 { '1034557': 3 }
members 0 { '1034557': 4 }
members 1 { '1034557': 4, '1034577': 1 }
members 1 { '1034557': 5, '1034577': 1 }
members 2 { '1034557': 5, '1034577': 1, '1034596': 1 }
```

- `fero('hello', { server: true })` is the whole setup. Each copy takes a free port and registers the name
  `hello` with the directory on your box; that is how they find each other. No addresses in the code.
- Each copy counts in one row, keyed by its pid: `f.data[process.pid] = ++n`. Plain assignment is the write,
  `f.data.tap(…)` runs on every change that lands, and every terminal prints the same object.
- `members` is the agreed group. Ctrl-C is a clean stop: the copy asks the group to shrink before it exits,
  so terminal 1 drops to `members 1` and counts on, the stopped copy's row still there. Run it again: the
  new copy replays everything it missed, one line per record, is voted in, and takes a row of its own.

```sh
node server.ts                    # a third terminal: a third row, members 3
node server.ts --fero.dir ./a     # the same copy again after a restart, with its old rows
```

`node check.ts` runs this story on its own and ends with `ok 01-two-servers`, in under ten seconds.
Next: [02 · a shop and its watchers](../02-server-client/).
