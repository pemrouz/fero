# 15 · Addresses are just config

Terminals 1 to 3, one member each — its own port first, then the other two:

```
$ cd examples/15-static-topology
$ node server.ts 4801 4802 4803
MEMBER 270860 on 127.0.0.1:4801 — directory off — members 3
{ '270860': 9, '270861': 9, '270862': 9, '271157': 'client' }
```

```
$ node server.ts 4802 4801 4803
MEMBER 270861 on 127.0.0.1:4802 — directory off — members 3
{ '270860': 9, '270861': 9, '270862': 9, '271157': 'client' }
```

```
$ node server.ts 4803 4801 4802
MEMBER 270862 on 127.0.0.1:4803 — directory off — members 3
{ '270860': 9, '270861': 9, '270862': 9, '271157': 'client' }
```

```
$ node client.ts 4801 4802 4803
CLIENT 271157 — hosts 127.0.0.1:4801 127.0.0.1:4802 127.0.0.1:4803 — linked 3
{ '270860': 9, '270861': 9, '270862': 9, '271157': 'client' }
```

```
$ node refusals.ts
refused: a client needs something to dial
refused: an undialable node (listen: false) cannot join a cluster
refused: explicit listen required when dialing non-local hosts
refused: server: false pins the client role, but 'listen' makes a server
refused: listen 0.0.0.0:3376 would take the directory's socket (127.0.0.1:3376)
refused: names starting with # are reserved for system resources (#directory)
refused: 'update' is a function
```

- `rendezvous: false` turns the directory off — each member says so — and every address is in the call: a
  member gets `listen` (its own port) and `hosts` (the others), a client gets `hosts`. Nothing is looked up:
  cross-box discovery is not implemented, and this is the one-box shape, so every address here is loopback.
- Each member counts in its own row, keyed by its pid. The client writes one row, once: a member stamps it
  and every screen shows it, the client's too. `linked 3` is the members it reaches; a client joins no vote.
- A shape that cannot work is refused at `fero()`: a rejected promise, never a node that runs and finds
  nobody. `refusals.ts` tries seven, printing each answer's first clause; the full one says why, or the fix.

```sh
node client.ts 4801              # one address is enough: the client learns the rest, linked 3
node server.ts 4803 4801 4802    # Ctrl-C a member, run it again: same address, voted back in, members 3
node server.ts 4804 4801         # a fourth member, told one address: members 4 on every screen
```

`node check.ts` runs this story on its own and ends with `ok 15-static-topology`, in about six seconds.
Next: [16 · every row on exactly two members](../16-scoped/).
