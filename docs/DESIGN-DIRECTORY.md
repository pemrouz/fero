# DESIGN-DIRECTORY — the per-box rendezvous directory (V4-3)

The v4.1 derived port (fnv1a32(name) → one of 1024 loopback ports, DECISIONS
V4-2) made "a bare server and a bare client find each other by name" work with
zero addresses — and welded WHERE a resource lives to HOW it is found. Measured
consequences (2026-08-30, live experiments against the tree):

- **Name collisions.** 1024 slots on one box: P(collision) ≈ 4% at 10 distinct
  names, 17% at 20, 50% at 38. Loud (bind refusal / HELLO name-reject), but the
  only remedy is "rename the resource or pass listen".
- **One bare server per name per box.** The second `fero(name, {server: true})`
  is EADDRINUSE, never a cluster.
- **The genesis coin-flip.** A bare hub has no `hosts`; genesis is proposed by
  the lowest-uuid node ONLY if it has hosts (`links ≥ hosts.length`,
  kernel/membership.ts). Hub lowest ⇒ the view never forms; everyone sits at
  epoch 0. Pinned: uuid `aaaa` never forms, `zzzz` forms.
- **A bare client can only START from the derived port.** If no server is
  bare (all explicit `listen`), it dials nothing — `peers: []`.
- **Hub death kills discovery for NEW joiners.** Existing nodes keep their
  VIEW-learned links; a fresh `fero(name)` finds nobody until some server
  re-binds the derived port.

## §0 Decision

Replace the derived port with a **per-box directory**: one fixed, well-known
loopback address (`RENDEZVOUS`) whose binder runs a soft-state registry
`name → {uuid: listenAddr}` served as a **system resource `#directory`**. The
data role of every user resource stays a pure function of its config (V4-2's
invariant); only the *discovery* role is first-to-bind, and it is soft state
that any surviving server re-hosts.

- Servers bind **any free port** (`listen` omitted ⇒ `127.0.0.1:0`, the OS
  picks) and `register`. Clients and servers `lookup(name)` as a LIVE
  subscription; the addresses flow into the kernel through one new event,
  `discover`. Nobody hashes anything.
- The registry is method-plane state on the host (a data proxy, never a log,
  never a WAL). Takeover = the existing Caller failover (re-subscribe; the fresh
  snapshot root-replaces the mirror) + re-register on link-up. No anti-entropy,
  no tombstones, no sweep. **Rejected:** the registry as replicated `data` —
  soft state through a CRDT log needs a takeover sweep against lanes anti-
  entropy resurrects from clients (the old host's cells outlive the old host).
- `RENDEZVOUS = '127.0.0.1:3376'` ("FERO" on a keypad). Below Linux's ephemeral
  range (32768–60999) so `listen(0)` can never hand it to a resource. Loopback
  only by default — the peer plane is unauthenticated (V4-2's rule survives).

What this does NOT change: the explicit `listen` + `hosts` cluster shape (works
with the directory off), the 2-member-quorum and ghost-identity facts (`dir` +
≥3 members is the deployment rule, documented), the HELLO name echo (still the
misdial guard — a user resource dialing RENDEZVOUS by mistake is refused by
name).

## §1 Names: `#` is reserved

`fero('#…')` throws for users: *system resource names (the # prefix) are
reserved*. The composer's internal entry (`compose(name, opts, {system: true})`,
not exported from `.`) is the only way to make one. The name rides HELLO
unchanged, so `#directory` nodes are distinguishable in captures, the journal,
and `cluster.me` — and a user can never take the name by accident. `#directory`
never registers itself and never looks anything up.

## §2 Kernel: the `discover` event

`{ kind: 'discover', hosts: string[] }` — replaces the node's DYNAMIC host set.

- `node.hosts` = static (`NodeOpts.hosts`) ∪ dynamic, deduplicated, minus the
  node's own listen. Read by genesis (`hosts.length > 0 && links ≥ hosts.length
  && lowest uuid`, unchanged) and by give-up revival (`#revivable`). Cached:
  rebuilt only when the set changes, so the per-heartbeat readers stay
  allocation-free.
- **Added** targets: `JK.dial` + `sink.connect(to)` unless a live link already
  covers the target (dialed `to` or gossiped `listen` equal) or a backoff chain
  is actively trying it (`dialing(to)`).
- **Removed** targets: forget the backoff entry (revival stops). A live link is
  NOT closed — a peer's departure is a link fact, not a directory fact; the
  link dies on its own and the redial chain does not restart for a forgotten
  target (linkDown consults `hosts`/view before redialing a dialed `to`).
- Deterministic and replayable; the sim can post it. No new journal kind (the
  JK vocabulary is pinned by the debugger's tests): dials journal as `JK.dial`.

Genesis over a dynamic set proposes whatever is linked when the lowest uuid
sees `links ≥ hosts`; a registrant that shows up later joins through the
existing JOIN path at the next epoch. A solo server (nobody else registered)
stays at epoch 0 — exactly today's solo. **Panel question (Q2):** is a partial
first view worth a one-heartbeat settle after the last `discover` change?

## §3 Shell: port 0

`listen: 'host:0'` binds an ephemeral port; the shell writes the actual
address into `node.listen` INSIDE the listen callback — before the `start`
step and before any accepted socket can HELLO (accept fires only after
listen). `Node.listen` becomes an assignable field; the sim never binds, so it
is untouched.

## §4 The composer (api/index.ts)

Role rules are V4-2's, verbatim. Topology:

| shape | listen | directory |
|---|---|---|
| server, `listen` omitted | `127.0.0.1:0` → real address after start (`cluster.me.listen`) | register + lookup + host attempt |
| server, `listen: 'host:port'` | as given | register + lookup + host attempt |
| server, `listen: false` | none | none (no register, no lookup, no host) |
| client (bare) | none | lookup only; `hosts` = discovered set |
| client, `hosts` given | none | lookup; `hosts` = static ∪ discovered |

- New config key **`rendezvous?: string \| false`**: the directory address
  (default `RENDEZVOUS`; the environment variable `FERO_RENDEZVOUS` overrides
  the default — an address, or `off`). `false` = no directory at all (the
  pure-static shape: today's behavior byte-for-byte).
- The loopback guard survives: a server dialing non-local `hosts` needs an
  explicit `listen` (an ephemeral 127.0.0.1 listen gossiped to a remote peer is
  the same futile-dial-back V4-2 refused). Widened in §11 into the
  explicit-listen rule.
- `derivedAddr` is deleted (4.x pre-release; V4-2 shipped a week ago). Every
  "derived port" error/comment goes with it.
- `cluster.me` grows: `hosts` on EVERY role (the effective static ∪ discovered
  set), and `rendezvous: { addr: string, hosting: boolean, up: boolean }` (or
  `rendezvous: false`) — the observability finding of V4-2's review, extended:
  a bare client's "nobody registered yet" and "no directory on this box" must
  read differently.
- `destroy()`: unregister (best-effort, bounded), destroy the directory client,
  then the hosted directory if this instance hosts it (⇒ takeover elsewhere).

## §5 The directory host (api/directory.ts)

`compose('#directory', { listen: rendezvous, heartbeatMs, redialMs, register,
unregister, lookup }, {system: true})` — one hosted per box, attempted by every
dialable SERVER instance (clients host nothing: serving is a declared act, and
a watcher-hosted directory would churn with every watcher restart — Q1).

- `register({name, uuid, listen}, ctx)`: validates (name non-empty and not
  `#`-prefixed; uuid non-empty; listen `host:port`) and records the entry under
  the CALLER (`ctx.peer` — a new `Context` field: the invoking link's uuid,
  undefined for a local invoke). Writes `registry.get(name).set(uuid, listen)`.
  Idempotent.
- `unregister({name, uuid}, ctx)`: removes the field if the caller owns it.
- `lookup(name)`: returns `registry.get(name)` — the live child view. Verified
  by prototype: inserts, field adds and field removes stream; the initial
  snapshot of an absent row is `{}`; a takeover re-subscribe root-replaces
  with the new host's snapshot. Whole-row removes do NOT stream, so rows are
  never removed — only fields.
- Link death: the host taps its own `cluster.peers`; when a registrant's uuid
  is no longer up, every entry it registered is removed. Entries live exactly
  as long as their registrant's link to the CURRENT host.
- Refusals are typed rejections through the method plane (the caller sees a
  reason, never a silent no-op).

## §6 The directory client (api/directory.ts)

Per fero instance (uniform, no process-level state — Q5 rejected a shared,
refcounted per-process client; superseded 2026-10-11, §12: one client per
process): `compose('#directory', { hosts: [rendezvous],
heartbeatMs, redialMs }, {system: true})`.

- Link-up (the directory primary appears): servers `register` (`{retry: true}`
  — idempotent; re-issued on EVERY link-up, so a takeover host rebuilds its
  registry from the registrants themselves).
- `lookup(name)` opened once as a live handle; every change folds to the
  address set (minus own listen) → `rt.node.step({kind: 'discover', hosts})`.
  A held SUB before the first primary is re-issued by `onPrimaryChange` (the
  existing policy).
- Link-down (servers only): the host-attempt loop — after a jittered delay
  (50–250 ms) try `compose('#directory', {listen: rendezvous …})`; EADDRINUSE
  ⇒ try again on the next delay until the directory link is back up or this
  instance is hosting. Losers of the race simply reconnect as clients.
- A foreign process squatting on the rendezvous port: the bind fails, the
  client's framer rejects the garbage, the link drops and redials at the
  capped backoff — the resource itself is unaffected, and
  `cluster.me.rendezvous.up` stays false (the observable).

## §7 Discipline: tests, perf, sim, docs

- `npm test` and `npm run perf` run with `FERO_RENDEZVOUS=off`: the battery's
  explicit-topology tests stay isolated from any other tenant on the box
  (concurrent sessions run tests here). Discovery tests opt in with a free
  rendezvous port EACH — no fixed port in a test, ever.
- Tests: kernel `discover` (dial / cover / forget / revival; genesis over a
  discovered set; sim-postable); shell port 0; api: `#` reserved; N bare
  servers form a view with NO uuid pinning (the coin-flip closed); a bare
  client finds explicit-listen servers; directory host death → a NEW
  `fero(name)` after takeover still finds the survivors; two different names
  never collide; unregister on destroy; the misdial refusal unchanged; the
  two-terminal demo path both restart orders.
- Perf: cold paths only. With the directory off, boot is unchanged (pinned by
  the existing battery). With it on, boot adds one bind attempt and one
  Runtime — measured and recorded, no hot-path change. `node.hosts` is cached
  (the heartbeat readers allocate nothing).
- Docs: README (the v4.1 section + api table), DECISIONS V4-3, STATUS ledger,
  CLAUDE.md role model, api/types.ts comments, the demo, IDEAS (debugger badge
  for `#` resources — viewer.html is mid-edit in another session).

## §8 Panel questions

- **Q1** Clients host nothing. Correct, or should a box of watchers get a
  directory?
- **Q2** Genesis over a dynamic host set — partial first view + JOIN, or a
  one-heartbeat settle?
- **Q3** Should the host dial back a registered `listen` before publishing it?
  (Current answer: no — dial failures and the name echo handle a bad address.)
- **Q4** Port 3376 and the `FERO_RENDEZVOUS` override.
- **Q5** Per-instance directory client vs one shared per process.
- **Q6** Anything in the takeover window that can strand a registrant or a
  lookup permanently (the failure mode that matters most).

## §9 Amendments after the adversarial pass

(The four-lens panel run was refused by a session usage limit; this pass was
done by hand against the tree. Re-run the panel on the implementation.)

- **No `unregister` method.** Link death IS the mechanism: a clean destroy
  closes the socket (FIN → linkDown on the host, immediate) and a crash does
  the same via the OS. Entry lifetime IS the registrant's TCP connection to the
  current host: a hung-but-connected process keeps its entry (the kernel runs
  no failure detector over client links — PONG is proof of life, not
  accounted; suspicion ranges over committed members only), exactly as it
  keeps its cluster membership. The host removes every entry a registrant made
  when its uuid is no longer up in `cluster.peers`. Fewer moving parts than a
  best-effort call racing `Caller.destroy`.
- **A user resource may not `listen` on a rendezvous socket** — refused at
  compose time under ANY spelling that lands on the same loopback socket
  (`0.0.0.0:3376`, `localhost:3376`, `[::]:3376`; the panel's bypass), against
  the instance's own rendezvous, the process default, AND the constant (so
  `rendezvous: false` cannot squat a socket a later process will dial). And
  the kernel no longer strands on a squat at all: a name-rejected DIALED
  target is parked given-up, so give-up revival re-dials it once per
  heartbeat — a squat is a heartbeat-bounded nuisance that heals when the
  right resource appears (`kernel/discover.test.ts`, the name-reject pin).
  A NON-fero squatter: framer garbage → a normal linkDown → a bounded chain
  → give-up → revival every heartbeat → recovers the moment it leaves.
- **`discover` removal cancels, then parks only what is still named.** A
  forgotten target's armed redial timer is CANCELLED (the panel found the
  park-then-re-add fork: an orphaned timer plus a fresh dial ran the chain
  doubled); the entry is parked — `dialing()` false, `#redial` ends the chain
  and drops the entry — only while a live link or an in-flight dial still
  names the target, and simply deleted otherwise, so `#backoff` is bounded by
  the live link set rather than by every address a port-0 server ever had.
  Static hosts and committed members are never parked by a discover.
- **Register on EVERY directory primary change** (`{retry: true}`; idempotent).
  Peer-down cleanup is keyed by uuid TRANSITIONS: a registrant that reconnects
  before the host processes its old link's close keeps its uuid up (the fold
  rebuilds peers from live links) — nothing is deleted; if the close lands
  first, the entries go and the link-up re-register restores them.
- **Genesis over a dynamic host set, concurrent proposals:** the ballot already
  arbitrates — proposing SPENDS the node's one vote per epoch (`votedFor`), a
  loser burns the epoch and re-targets past it, and a node that installs a view
  it is not in JOIN-knocks (the path the restart-as-new-uuid scenario already
  exercises). No settle window; the test pins repeated no-pin formation.
- **Takeover with an empty row:** the first `lookup` snapshot from a fresh host
  is `{}` → `discover([])` parks the discovered targets; live links are
  untouched, registrants re-register within one round trip, the row refills,
  `discover([...])` re-adds (covered targets just clear their park). A
  transient, not a strand.
- **Panel answers:** Q1 no (clients host nothing). Q2 no settle. Q3 no
  dial-back. Q4 3376 + `FERO_RENDEZVOUS`. Q5 per-instance (superseded by §12:
  one client per process). Q6 covered above.

## §10 The implementation panel (after landing)

Five lenses (kernel, directory mechanics, composer, tests, ops) × a skeptic
per finding, against commits 26213b2/e28e48a/b8a4f73: 25 confirmed, 0
refuted, 8 major. Every major was reproduced with a scratch script. Fixed:

- **The squat strand** (composer + kernel, above): the string-compare guard
  was bypassable (`0.0.0.0:3376`, `localhost:3376`, `rendezvous: false`), and
  a name-rejected target was never revived. Now `sameSocket` refuses every
  spelling against own/default/constant, and the kernel parks a name-rejected
  dialed target given-up so revival re-dials it each heartbeat.
- **Owner keys split on the first space** — a name with a space never had its
  entries removed. Keys are `JSON.stringify([name, uuid])` now.
- **Cleanup by (name, uuid) without ownership** — a dir-restored identity
  re-registering while its wedged predecessor's socket was still open lost
  its cell when that socket finally closed. `owner` maps each cell to its
  CURRENT registrant; the later registrant wins; only the owner's death drops.
- **The battery's isolation lived in one npm script** — a single-file
  `node --test api/index.test.ts` met the box's real directory. Every suite
  that composes without a rendezvous now pins `FERO_RENDEZVOUS ??= 'off'` at
  import.
- **No deterministic pin for the fold-order defect** — `hostMethods` is an
  exported test seam; the exact tap-before-publish shape, GRACE, ownership
  transfer, the space-name and the per-caller cap are unit-pinned.
- **The bind-retry loop composed a full Runtime 4–20×/s forever** against a
  held port — now a `listen()/close()` probe gates the compose, the delay
  doubles per consecutive failure to a 5 s cap, and a non-EADDRINUSE errno
  (EACCES on a reserved Windows band, EADDRNOTAVAIL on a foreign interface)
  is surfaced on `cluster.me.rendezvous.error` (as is a register refusal).
- Minors: `listen: false` reported the directory as *down* rather than
  absent (`meets` is now the one predicate); `FERO_RENDEZVOUS=garbage` failed
  deep in the shell (refused at fero() time, variable named); `isAddr`
  accepted `'127.0.0.1:'` and port 0 for a rendezvous; precedence (config >
  env > constant) is documented; the takeover test's bound is derived from
  the redial chain it actually waits for; instances are built inside
  try/finally; a per-caller cap (4096) bounds a runaway registrant.

Accepted as designed / documented rather than fixed: any local process can
register any name (loopback is the trust boundary — it could equally dial the
resource and HELLO with that name); a hung-but-connected registrant keeps its
entry (the kernel has no client-link failure detector — IDEAS); the shell's
timers are ref'd, so a process holding only a bare client does not exit
without `destroy()` (pre-existing; IDEAS); 3376 sits inside the band Windows'
Hyper-V may reserve at random — the errno surfaces and the retry backs off.

## §11 Cross-box discovery: `hosts: ['10.0.0.5']` (2026-10-08)

Until now a box knew only its own directory. A server on another box could be
reached only by writing its full `host:port` in `hosts`.

### The spelling

A `hosts` entry with NO port names another box: "ask that box's directory".

- **The port** is this instance's rendezvous port: `rendezvous:` if set, else
  `FERO_RENDEZVOUS`'s port, else 3376. Every box runs its directory on the
  same port, so a box is named by its host alone.
- **A bare host** is a DNS name or a dotted IPv4 (labels of letters, digits and
  inner hyphens), or a bracketed IPv6 (`[fe80::1]`). A lone number (`'50'`, a
  port missing its host) and a stray flag read off argv (`--fero.heartbeat.ms`)
  are still refused as hosts, naming the entry.
- **The directory off** (`rendezvous: false`, `FERO_RENDEZVOUS=off`) refuses a
  bare host: there is no port to ask at, and picking 3376 in silence could
  meet a stranger's directory. The message names both fixes (give the entry
  its port, or turn the directory on). This also keeps the battery, which runs
  with the directory off, from ever dialing the box's real directory.
- **This box's own directory** (`'localhost'` or `'127.0.0.1'` when the
  rendezvous is `127.0.0.1:3376`) is not asked twice: one canonical spelling
  per loopback name. Names are case-blind (`'LOCALHOST'`), and a wildcard
  dialed lands on loopback (`'0.0.0.0'` is `127.0.0.1`, `'[::]'` is
  `[::1]`). `'[::1]'` is NOT `127.0.0.1`: that is another socket, so it is
  asked like another box and reads down.

### What asking does

For each distinct bare host the instance opens one more `#directory` CLIENT,
dialing `<host>:<rendezvous port>`, and opens `lookup(name)` on it as a live
subscription, exactly as §6 does for its own box. The addresses of every
source (its own box's directory and each asked box) are unioned, minus its own
listen, and post as ONE `discover`. Nothing in the kernel changes.

- **Ask only.** It never registers on another box and never tries to host
  there (that socket is on another machine). A box's directory keeps listing
  exactly that box's servers, and an entry's lifetime stays its registrant's
  link to its OWN box's directory (§9). **Rejected:** registering on every
  asked box. It would make each box's directory a copy of the cluster (the
  view already gossips that), and an entry's life would hang on a cross-box
  link. A cluster still forms whichever uuid sorts lowest: a server that was
  told nothing proposes over the members that dialed it (I-22).
- **The other box must answer.** A directory binds its rendezvous address, and
  the default is loopback. So the box being asked runs with a routable
  rendezvous, `FERO_RENDEZVOUS=10.0.0.5:3376` on that box. Making a box
  askable is the operator's explicit act, never a default (the trust boundary
  in §0 is unchanged: the directory is as unauthenticated as the peer plane).
- **A misdial** (the far port holds a user resource, not a directory) is
  refused by the HELLO name echo: `#directory` is not its name. The asked box
  reads down, nothing links, the resource is untouched, and the kernel
  re-dials at heartbeat cadence (§9's squat rule), so the box is found the
  moment a real directory answers there.
- **The asking side's guard.** An address another box's directory hands out
  whose host is loopback or a wildcard would dial THIS box, so it is dropped,
  unless it sits on the very host that directory answered on (two loopback IPs
  standing for two boxes, as the tests do). The compose-time rule below keeps
  such addresses out of an askable directory in the first place; this guard
  covers a registrant composed under a different rendezvous spelling on that
  box (`127.0.0.1:3376` registering into a host bound to `0.0.0.0:3376`).
- **Observability.** `cluster.me.rendezvous.boxes` maps each asked directory
  to `{ up, error? }` (`error` is a failed lookup). A failed lookup is over
  for good (the Caller never re-subscribes a failed sub), so `error` stays
  set even when the link comes back: clearing it would read a dead lookup as
  a healthy box. (2026-10-11, §12: the lookup is now opened again with
  backoff, and `error` clears when it answers.) Present only when `hosts`
  names another box, so every existing shape reads as before. The internals
  door's `diag(f).rendezvous().boxes` holds the asked clients themselves.

### The explicit-listen rule

A server's `listen` is the address other nodes are told: its box's directory
publishes it, and HELLO carries it to every peer, which gossips it on. If that
address leaves this box, a loopback listen points the other box at ITSELF (a
futile redial forever, or a same-named stranger welded into membership), and
a wildcard (`0.0.0.0`, `::`) is no address at all.

So a server is refused at `fero()` with

> to be reachable from another box, listen on a routable address

followed by the reason and the listen, exactly when BOTH hold:

1. **Its listen is loopback or a wildcard**: `127.*`, `localhost`, `::1`,
   `0.0.0.0`, `::`. The default listen (`127.0.0.1:0`) is loopback, so a
   server that names another box must name its listen too.
2. **The listen would leave this box**, for either reason:
   - its **rendezvous is not loopback** (a routable address, or a wildcard,
     which answers other boxes too): other boxes can ask that directory, and
     it would hand them this listen; or
   - its **hosts name another box**, with a port (a member there learns this
     listen from HELLO and gossips it) or without one (it asks that box's
     directory and dials what it finds, with the same HELLO).

"Another box" means a host that is not loopback and not a wildcard. Two
loopback IPs (`127.0.0.1`, `127.0.0.2`) are this box: that is what lets the
tests stand two boxes up on one machine.

Clients are never refused: a client has no listen and is never published.
The directory's own system resources skip the rule (they are composed with
explicit addresses by the composer).

This replaces V4-2's narrower guard ("explicit listen required when dialing
non-local hosts"), which refused only the DEFAULT listen beside a ported
remote host. Two shapes it let through are refused now, on purpose: an
explicit loopback listen beside a remote host (`listen: '127.0.0.1:4000',
hosts: ['10.0.0.5:4000']`), and a wildcard listen beside one (`0.0.0.0:4000`).
Both were broken already: the peer was told an address that dials its own box.
fero has no "bind everywhere, advertise this" split; `listen` is both.

With nothing set (no `hosts`, the loopback default rendezvous) neither
trigger holds, so every one-box shape, the examples included, is untouched.

### Tests (api/directory.test.ts)

- Two boxes on one machine: box A at `127.0.0.1:P`, box B at `127.0.0.2:P`
  (one rendezvous port, a directory each). A server on box A told the bare
  host `127.0.0.2` asks box B's directory; the two servers form one view;
  a second server on box A changes box A's own row and box B's server stays
  in the dial set (the union over sources, mutation-checked);
  `rendezvous.boxes` reads B up; a bare client on each box reads writes made
  on the other; box A's directory never lists box B's server (asking
  registers nothing); a client on box A told only `127.0.0.2` finds box B's
  server. Skipped where `127.0.0.2` is not loopback (macOS without an alias).
- A misdial: box B's rendezvous port held by a user resource. The box reads
  down, the resource admits nobody, and the name rejects repeat.
- Every case of the rule (default, explicit loopback, wildcard; a bare and a
  ported remote host; a routable and a wildcard rendezvous), a routable
  listen passing the rule (it reaches the bind), the directory-off refusal,
  and the helpers (`isBox`, `boxDirectory`, `sameDirectory`, `fromBox`,
  `leavesBox`) unit-pinned.
- The two-box tests fail with the asking path removed (mutation-checked).

The task asked for "two private rendezvous ports on this box". That shape
cannot stand for two boxes: a bare host asks at the asker's OWN rendezvous
port, so two directories on one IP at two ports cannot name each other. Two
loopback IPs at one port is the faithful shape, and the one used.

### Left open

- A routable directory is reachable by anyone who can reach the box, and the
  peer plane is unauthenticated. Peer authentication (wave 3's door) is what
  makes an askable directory safe off a trusted network.
- A box asked by name is resolved once per dial by the OS (no caching, no
  SRV records). A box whose directory is down costs one dial per heartbeat
  after the redial chain gives up, like any parked target.

## §12 The leftovers, closed (2026-10-11, wave 5e)

Five things the earlier sections left open. Each landed as its own commit
with its test.

### IPv4-mapped loopback

`[::ffff:127.0.0.1]` dials and binds the same socket as `127.0.0.1`
(measured here: a mapped dial reaches a `127.0.0.1` listener, and a
`127.0.0.1` dial reaches a mapped bind). The host checks compared strings,
so a mapped spelling read as another box: it could squat the directory's
socket, slip past the explicit-listen rule (§11), and be asked for a
secret as if other machines could reach it. A new `unmap()` turns a mapped
spelling into its IPv4 address, and `localish`, `loopbackHost` and
`canon` read through it. An IPv6 literal has many legal spellings
(`::ffff:127.0.0.1`, `0::ffff:127.0.0.1`, `0:0:0::ffff:7f00:1` …), so
`unmap()` first puts it in its one standard form (the URL parser's:
lowercase, zeros compressed, the low 32 bits in hex) and matches the mapped
prefix once. A scoped address (`fe80::1%eth0`) comes back unchanged. A mapped routable address (`[::ffff:10.0.0.5]`)
stays routable. The composer's rules use the same helpers, so they follow.

### A failed lookup is opened again

§11 said a failed lookup is over for good (the Caller drops a failed sub)
and kept its `error` set so a dead lookup would not read healthy. Two gaps
were left: an asked box added nothing more until restart, and on this
box's own directory the next successful register cleared the one shared
`error` while the lookup stayed dead.

Now each lookup (this box's and every asked box's) is opened again after a
jittered delay that doubles per consecutive failure up to 5 s, the
bind-retry loop's numbers. A re-subscribe while the link is down is held
and replayed on the next primary, like any sub. The directory keeps its
bind, register and lookup troubles apart, and `error` joins them (bind
first). A lookup's error clears only on the first frame of a lookup opened
after the failure: the lookup itself recovered. `rendezvous.boxes` follows
the same rule.

### A failure detector over client links

§9 and §10 accepted that a hung-but-connected registrant keeps its entry
(the kernel ran no failure detector over client links). A process stopped
with its socket open kept its entry for ever, and every lookup handed out
its dead address.

The directory host now runs one. A new kernel option, `watchClients`, is
set only on the `#directory` host (the composer sets it for a system
compose of that name with a listen):

- Every heartbeat the host PINGs every admitted client link, whatever the
  uuid order. Before, only the lower uuid PINGed, so a client with a lower
  uuid was heard only at its OWN heartbeat, and a client with heartbeats
  off was never heard at all. A client answers a PING on receipt, so a
  live one is heard every host heartbeat however slow its own cadence.
- A client link that carries no byte in for more than `WATCH_TICKS` (20)
  host heartbeats is closed: 10 s at the default 500 ms. Its entries go
  through the existing peer-down cleanup. A registrant that wakes up finds
  its link closed, redials and registers again.
- The kernel change is the smallest one liveness needs: a `quiet` counter
  on `Link`, reset by one store per chunk in, and the extra PING and the
  close, both behind the option. Without the option nothing changes (no
  extra PING, no close, no journal row), so every sim trajectory and golden
  is unchanged. The close journals no row of its own (a named row would
  need a new journal kind and the debugger's vocabulary); the linkDown
  that follows shows it.

Measured over three runs: a SIGSTOPped registrant left the lookup 1020 to
1050 ms after the stop at a 1000 ms bound (heartbeat 50 ms); a live registrant whose
own heartbeat was 40 times slower than the host's stayed through three
bounds; the stopped one, continued, registered again.

### One directory client per process

§6 and §9 Q5 chose a client per instance ("uniform, no process-level
state"). That is superseded: N resources in one process cost the host N
links. Now instances in a process that meet the same directory at the same
heartbeat and redial share one `#directory` client and its link; the same
holds for each asked box's directory. Each instance still opens its own
lookup on it, registers its own entry through it and taps its link state,
and takes them off again on destroy.

- Counted by reference. The last instance out destroys the client: its
  link drops and the host forgets what is left, as before.
- An instance that leaves while others stay cannot rely on the link
  dropping, so the host has an `unregister({name, uuid})` method again
  (§9 removed it when the link was the only mechanism). Only the entry's
  current owner, the calling link, may remove it; anything else is a no-op
  that says false. A leaving server ALWAYS calls it while the shared
  client stays, whatever it believes about its own register: `fero()`
  resolves before the first register comes back, so a server stopped in
  that window used to skip the call, and the register then landed for
  good (the review's probe leaked 10 of 10 entries). The call carries
  `retry: true`, so one held while the link is down, or lost with a dying
  primary, is sent again on the next primary, after any register sent
  before it (the Caller replays in call order). The stop waits for it only
  while the link is up, bounded at 2 s. A register that settles after the
  stop sends nothing more: that call order already puts every register this
  instance sent before its `unregister`, and a register that timed out here
  is never replayed. A second `unregister` sent then was tried and taken
  out again (same day, second review): `unregister` is keyed by
  `(name, uuid)` and the calling link, the link is shared, so when the same
  identity restarted in the same process (a `dir` server keeps its uuid)
  the old instance's late call dropped the NEW instance's live entry.
- A host from before this change has no `unregister`: the entry then
  lives until the shared link drops, as every entry did before.
- Different heartbeat or redial settings get their own client: the
  client's cadence is the instance's failover speed. The pool is keyed by
  the compose seam too, so the composer hands every instance one
  module-level compose, and a test's stand-in compose never meets the
  composer's clients.

### The I-19 probe

STATUS named the next probe for I-19 (`c.methods.lookup is not a
function`, seen once right after the host died): a survivor racing the
newcomer for the port, the EADDRINUSE path in `#tryHost`. Two tests write
it. One forces it through the compose seam (the newcomer's probe says
free, a survivor binds before the newcomer's real bind, which meets
EADDRINUSE); the other runs it for real (a hosting process and a survivor
process, the host SIGKILLed, a newcomer 0 to 400 ms later; both the
newcomer and the survivor win in one run). Every time the newcomer's
`fero()` resolves, exactly one hosts, and the newcomer finds the survivor.
Not reproduced: no fix, and the guard in `#client` stays.

### Tests (api/directory.test.ts, kernel/watch.test.ts)

- Every mapped spelling, the routable ones, and each place the helpers are
  used (the squat guard, the asked-twice filter, the asking side's guard,
  the rule, the composer's refusal and its secret rule).
- A stand-in host whose lookup throws while a flag is set and whose
  register succeeds: the error survives a successful register, the lookup
  is opened again, the error clears when it answers. An asked box whose
  directory fails, goes away and comes back healthy: its error stays while
  dead and clears when the new one answers; its server is found.
- The SIGSTOP test above; the kernel suite pins the PING to a lower-uuid
  client, the bound, the reset on any byte, off by default, and members
  left alone (mutation-checked: no extra PING, no close).
- Sharing: four instances hold one client (the host counts one shared link
  beside its own); one leaving unregisters and keeps the others' lookups
  and registrations live; the last one out closes it. The host table's
  `unregister` rules are unit-pinned. With the unregister call removed the
  sharing test and the I-34 test both fail.
- The stop-at-once window: six servers started and stopped at once (three
  destroy, three crash) beside a sibling holding the shared client leave
  no entry. Before the fix: 6 of 6 leaked. The always-sent unregister
  closes it alone.
- The same identity stopped and restarted in one process keeps its new
  entry: a stand-in host on the real `hostMethods` applies each register
  at once and answers it 1.5 s late; the restart's entry is still there
  after the old register's answer. With the late-register unregister it
  failed (the row read `{}`); the reviewer's real-process probe lost the
  live server in 6 of 8 runs, and 0 of 8 without that call.
- The lookup re-subscribe never hammers: at most 10 lookups in 2 s while
  the host keeps failing them (with no backoff: 538).
- The two I-19 race tests above.

### Left open

- The debugger still cannot attach a `#directory` node (a system compose
  takes no `diag.allow`).
- An askable directory is still unauthenticated (V4-30).
- A silenced client link has no journal row of its own.

## §13 The genesis gate: a target that refused this node leaves the count (2026-10-12, wave 6b)

The bug. Genesis at the lowest-uuid member waits for `links ≥ hosts` (§2), and `hosts` counts the
discovered set, so a squatter the directory handed out — a process on that address that is not one
of us — held the first view for good; found by the door family (`sim/door.test.ts`), which told a
non-lowest member about the squatter on purpose to stay clear of it. STATUS carried the line "A
discovered target that never admits holds genesis at the lowest-uuid member for good" with the
dead entry beside the squatter.

The rule. A DIALED target that refused this node as a stranger leaves the genesis count
(`kernel/node.ts` `#refused`, fed by `#refuse`; read by `kernel/membership.ts` at genesis):
the address I dialed answered for another name (`nameReject`), another cluster contract
(`contractReject`), or at the door (DESIGN-DOOR §3) — no secret where I have one, a secret where I
have none, the address rule, or a refusal notice for my proof. Such a target can never be admitted
here, so it can never be in a view with me; waiting for it could only block. Two refusals are NOT
strangers and stay counted: a proving `timeout` (a lost frame — the peer may be one of us), and a
`uuid-taken` notice (the far side holds a member running as me: my misconfiguration). Only my own
dial's outcome at the address I dialed counts, never a claim on an ACCEPTED link: a stranger that
can merely connect could otherwise send a HELLO naming a real member's listen with a bad proof and
shrink my count. The entry leaves when the target admits (a fixed secret or config heals at the
heartbeat's revival cadence, as the name-reject park always did, §9) or when the directory forgets
the target (a `discover` without it; a static host keeps its refusal, as it is never forgotten).

What stays. A target that merely never answers — a closed port, a cut — stays in the count. Two
rules were weighed and refused:

1. *A target leaves the count once its redial chain gave up.* Unsafe. Take four members told of
   each other and a cut {a,b} | {c,d} at genesis: every chain gives up on both sides, a's count
   drops to {b} and c's to {d}, a proposes `{a,b}`@1 and c proposes `{c,d}`@1 — two views at one
   epoch, both writable, and when the cut heals an equal-epoch VIEW with other members is ignored
   (one view per epoch is the safety rule), so two clusters for good. V4-55's genesis hold guards
   only a second ballot over a set that holds a member of the first (the granter's HELLO or refusal
   teaches the hold, and the ballot becomes joint over the first view); two disjoint halves share no
   voter, so no hold reaches either. The guard does not hold here, and the task's premise that it
   would was wrong.
2. *Genesis proceeds on a majority of the host list once a chain gave up.* Safe when every member
   holds the same list — two majorities of one set overlap, and the overlap's vote-once plus the
   genesis hold makes the second ballot joint over the first — but the kernel cannot know the lists
   agree. With the cross-box shape of §11 (every member of box A told the address of box B, and the
   reverse), a cut between the boxes at genesis gives each box a majority of its own list, and two
   views form where today both boxes wait. The directory's lists agree on one box; static lists are
   whatever each operator wrote.

So dead and cut stay the same from the dialer's seat, and CP at genesis is kept for them: the first
view waits for every target that might be one of us. The dead-entry half of the STATUS line is
answered elsewhere: the directory's failure detector over client links (§12) drops a registrant
that has gone silent within `WATCH_TICKS` host heartbeats (10 s at the default), the lookup's next
snapshot takes it off every member's discovered set (`discover`), and genesis proceeds; a dead
STATIC host is the operator's to remove, as it always was.

Safety of what changed, in one paragraph. Genesis under the rule proposes exactly when today's
rule would propose with the refused targets struck from the host list — and a refused target is
not a candidate member of this cluster (another name, another contract, another secret). So for
the members of this cluster the count is today's count: the lowest member proposes over its
admitted set when every host that could be one of us is admitted, the ballot is the same ballot,
one view per epoch rests on vote-once as before, and two halves of one list can never each form
(neither half's count ever drops below the other half). The only new behaviour is for a target
that is not one of us, and it is to stop waiting for it.

Pinned: `kernel/discover.test.ts` — the squatter at the lowest member forms `{aa,bb}`@1 at the next
heartbeat once zz refused it (red on the base: no ballot, ever), a chain that gave up stays counted,
the door's five answers sorted (no-secret and the notice refuse; timeout and uuid-taken do not; a
forgotten target takes its refusal with it, a static one keeps it), and the guard: four members cut
in two halves form nothing until the heal, then one view of four. `sim/door.test.ts` — the family
tells the LOWEST member about the squatter on even seeds (with the pair's delay fixed so the DOOR
notice lands before the close, as TCP delivers it; the sim's random-delay close model loses it,
DESIGN-DOOR §3) and asserts it read the refusal and formed; and a focused 30-seed test with the
lowest member told alone, red on every seed on the base. The `#directory` example checks are
unchanged. The STATUS line narrows to the operator's dead static host.
