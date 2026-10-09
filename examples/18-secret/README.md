# 18 · The shared secret

Terminals 1 and 2, one member each, the same secret in the environment of both — the value here is one
`openssl rand -base64 24` printed, typed in by hand. A screen is one line per change:

```
$ cd examples/18-secret
$ FERO_SECRET=wnxH+ZDVQyfo9xZAS/1cwBu0caZpkD+t node server.ts 4801 4802
{ '3114061': 'member' }
MEMBER 3114061 on 127.0.0.1:4801 — members 0
{ '3114061': 'member', '3114062': 'member' }
MEMBER 3114061 on 127.0.0.1:4801 — members 2
fero('vault'): refused a peer that connected as 127.0.0.1:4803 — it has no secret and this node has one; every member and client must share FERO_SECRET
{ '3114061': 'member', '3114062': 'member', '3114180': 'member' }
MEMBER 3114061 on 127.0.0.1:4801 — members 3
```

```
$ FERO_SECRET=wnxH+ZDVQyfo9xZAS/1cwBu0caZpkD+t node server.ts 4802 4801
{ '3114062': 'member' }
MEMBER 3114062 on 127.0.0.1:4802 — members 0
{ '3114061': 'member', '3114062': 'member' }
MEMBER 3114062 on 127.0.0.1:4802 — members 2
fero('vault'): refused a peer that connected as 127.0.0.1:4803 — it has no secret and this node has one; every member and client must share FERO_SECRET
{ '3114061': 'member', '3114062': 'member', '3114180': 'member' }
MEMBER 3114062 on 127.0.0.1:4802 — members 3
```

Terminal 3, over two runs — the same file without the secret, then with it:

```
$ node server.ts 4803 4801 4802
{ '3114100': 'member' }
MEMBER 3114100 on 127.0.0.1:4803 — members 0
fero('vault'): refused by 127.0.0.1:4801 — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)
fero('vault'): refused by 127.0.0.1:4802 — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)
^C
$ FERO_SECRET=wnxH+ZDVQyfo9xZAS/1cwBu0caZpkD+t node server.ts 4803 4801 4802
{ '3114180': 'member' }
MEMBER 3114180 on 127.0.0.1:4803 — members 0
MEMBER 3114180 on 127.0.0.1:4803 — members 2
{ '3114062': 'member', '3114180': 'member' }
{ '3114061': 'member', '3114062': 'member', '3114180': 'member' }
MEMBER 3114180 on 127.0.0.1:4803 — members 3
```

- The secret is config, never code: `FERO_SECRET` in the environment (or `secret:` in a `fero.opt.ts` in your
  home directory), and never a flag — `ps` and the shell history show every flag, so `--fero.secret` is
  refused. The role file never reads it. With a secret set, every link proves the peer holds the same
  one before anything else happens (a keyed hash over fresh nonces; the value itself never crosses the
  wire). fero prints the value nowhere, and `diag(f).config()` shows `<set>`.
- The third server is refused at the door. Both ends say so, on stderr, one line per peer and reason: the
  third names each member it dialed and the fix, each member names the peer that connected. It keeps
  redialing, but a line never repeats. It stays alone — `members 0`, its row on no other screen, no row of
  theirs on its own — and still stops cleanly on Ctrl-C. A client without the secret is refused the same way:
  every member and every client share the one value.
- The same command with the secret is admitted: `members 3` on every screen, and its row on all of them,
  nothing printed on the members (an admitted peer is no news). Changing the secret is a full stop and start of
  every member and client. After the handshake the wire is plain text, so the secret is a door, not a tunnel:
  use a private network between boxes.

```sh
openssl rand -base64 24                                       # a good secret: 32 characters of text
FERO_SECRET=<that> node server.ts 4804 4801                   # a fourth member, told one address: members 4 on every screen
FERO_SECRET=<another> node server.ts 4803 4801 4802           # a different one: the members say "its secret differs from this node's"
```

`node check.ts` runs this story on its own and ends with `ok 18-secret`, in about six seconds.
Next: [20 · looking inside](../20-inside/).
