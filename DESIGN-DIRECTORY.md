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
  the same futile-dial-back V4-2 refused).
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
refcounted per-process client): `compose('#directory', { hosts: [rendezvous],
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
  closes the socket (FIN → linkDown on the host, immediate), a crash does the
  same via the OS, and a hung process falls to the failure detector. The host
  removes every entry a registrant made when its uuid is no longer up in
  `cluster.peers`. Fewer moving parts than a best-effort call racing
  `Caller.destroy`.
- **A user resource may not `listen` on the rendezvous address** — refused at
  compose time. Otherwise a fero node of another name squatting the port would
  be name-rejected by every directory client (`dead + noRedial`, kernel/node.ts
  HELLO), and a noRedial link never starts a backoff chain, so give-up revival
  never reaches it: discovery on the box stranded until the processes restart.
  A NON-fero squatter is fine: framer garbage → a normal linkDown → a bounded
  chain → give-up → revival every heartbeat (the rendezvous is the directory
  client's static host) → recovers the moment the squatter leaves.
- **`discover` removal PARKS, not deletes.** Deleting a mid-flight chain's
  backoff entry would let its next linkDown restart from base (MAX_REDIALS
  more dials at a dead address). Parking sets the entry given-up at the cap:
  the chain's next failure stops, revival ignores it (not in hosts), and a
  later re-add clears the park and dials afresh. Static hosts and committed
  members are never parked by a discover.
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
  dial-back. Q4 3376 + `FERO_RENDEZVOUS`. Q5 per-instance. Q6 covered above.
