# fero

Distributed, replicated reactive resources for JavaScript. `await fero(name)` gives you a live object. Read it like a plain object. Change it by plain assignment. Derive live views from it. Every process that opens the same name sees the same object, on one box or across a cluster.

Underneath sits a deterministic kernel. Every cell keeps its last writer, decided by a logical clock (last-writer-wins, LWW). Every node keeps one log per writer and heals gaps by comparing digests with its peers. Members join and leave by vote. Each row has one owner, and only the owner stamps writes to it. A write-ahead log (WAL) makes a node durable. Thin shells wrap the kernel in real sockets and timers. A simulation executive runs the same kernel bytes on seeded chaos schedules, so a protocol bug is a seed you can replay and shrink. The reactive view layer is the sibling `data` engine (`../data`); fero owns the write surface.

This is fero v4: package `fero` 4.0.0, branch `v4`, the repo root since 2026-08-16. The v2 surface and the frozen v3 tree live on the `master` branch.

## Run it

```sh
npm install                                    # once after a clone: the one dependency (optcascade); Node 22.18 or later
cd examples/01-two-servers && node server.ts   # the example series, 28 rungs: examples/README.md
npm test                                       # 924 tests + data's 18 contract clauses, the 28 example checks included
npm run perf                                   # the 43 perf pins; perf:absolute / perf:pin for the persisted baseline (tools/perf/BASELINE.md)
npm run sim -- --seeds 1000                    # 1000 seeded chaos trajectories; a failing seed prints itself and reruns bit for bit
npm run shrink -- --seed 42                    # shrink a failing seed to a few steps; --replay <capture> reruns the repro
npm run debug                                  # the scenario dashboard at /, the debugger at /debug (http://localhost:4699)
npm run debug -- captures/seed-3.json          # open a capture; --live runs a real 5-node cluster; --attach h:p,h:p reads servers started with diag.allow
```

## The shape

```ts
import { fero } from 'fero'                                    // from a checkout: '../../api/index.ts'

const shop = await fero('shop', { data: { widgets: { stock: 3 } } })   // a seed is a server marker: this process serves
shop.data.widgets = { stock: 4 }                              // one assignment is one record, stamped by the row's owner
shop.data.tap(() => console.log(shop.snapshot))               // runs on every applied record; snapshot is the sync dense read
const low = shop.data.filter((r) => r.stock < 2)              // a live view, kept up to date by the data engine

const watcher = await fero('shop')                            // bare fero(name) is a client: it finds the server by name
watcher.data.sale1 = { item: 'widgets', qty: 1 }              // a client's write goes to its server, is stamped there, and echoes back
```

- **Roles.** A bare `fero(name)` is a client. Any server marker makes a server: `server: true`, `listen`, `dir`, `replicas`, a `data:` seed, or `methods:`. A server binds a free loopback port and registers with the box's directory at `127.0.0.1:3376`; a client looks the name up there. With the directory off, every address is in the call: `listen` plus `hosts`.
- **Writes.** A write shows when it commits: inside the assignment on the server that owns the row, and as the owner's echo everywhere else. Nothing shows early. A refused write never shows. Until it commits, a write is a `pending` row of `cluster.writes`. `await shop.methods.update(record, { confirm })` waits for one rung of the ladder. `committed` means the owner stamped it. `replicated` means a majority of the view holds it. `persisted` means a majority has it on disk. A reject says how far the write got. It is never a rollback.
- **Methods, and the door.** A function under `methods:` runs on the server; a client awaits it, and the reply follows the commit of every write it made. Declaring methods protects the resource: clients then change data only through them, and a client's plain write is refused `methods-only`. Reads stay open. `validation:` is a rule about what a record may look like, run on every write that enters a server.
- **Membership.** Servers form a view by ballot. A write needs the majority side of the view. Reads never wait. A clean stop (Ctrl-C, or `destroy()`) leaves by a vote, so two members survive a clean stop. The leaver keeps asking for the vote while it is connected to a member that is not itself leaving, for up to `leave.ms` (8 s by default), so a survivor that is stalled for a few seconds still gets to vote; with no such member connected it waits four heartbeats and goes. With three members, one of them crashed and not yet voted out (that takes about four seconds), a second clean stop waits the whole window and still ends as a crash: the vote it needs is the dead member's. Let the eviction finish first. On a scoped member (`replicas`) the clean stop also waits for the new holders to copy the partitions it held, up to a window of 16 heartbeats, so scaling down loses nothing. `destroy()` resolves `true` for a stop that was clean all the way, `false` when the vote did not come back in time, past the copy window, or when there was nobody left to copy to (the last member): then the rows only that member held go with it (back from its `dir` in its next life). A crash is different: voting a dead member out needs a majority of the whole old view, and one of two is not a majority, so two members cannot survive a crash, and a survivor stalled longer than the window sees one. The majority rule stays (V4-31). The deployment rule is three members plus `dir`.
- **Durability.** `dir` turns on a write-ahead log and a boot record. Run the same file again and it is the same node in its next life, its rows back before it has a socket. Kill -9 a whole cluster and restore it from the disks: no `persisted` write is lost.
- **Scoped replication.** `replicas: N` puts every partition (a top-level row) on exactly N members. A shard is never shown as the resource: a sync read or an operator on a scoped server throws a typed error, and `await f.data` gathers the whole.
- **Conflicts.** A cell keeps the record with the biggest stamp. Nothing merges. Two members that read a counter and write it back plus one lose an increment. Write one row per event and fold the rows (`sum`, `avg`, a sorted view) instead.
- **Your own code.** A view's function, a tap or another subscriber that throws never stops fero. The change it reacted to stands: a `filter` or `map` leaves that row out until the row changes, any other view that threw stops (a live method subscription over it then fails, with the reason), and everything else still updates. fero says so once per bug on stderr, with where your code threw: `fero('shop'): filter threw on row "x" — left out of that view until the row changes (TypeError: …, at file:///…/app.ts:4:7) — the change stands; fero carried on`. A `validation:` rule that throws on a client's write refuses that write (`validation-threw`), and a method whose result cannot be sent (a `bigint`) rejects that call; the server keeps running.
- **Process.** Ctrl-C and SIGTERM are a clean stop for every live instance, then the process exits 0. A client holds its process open while it follows, just as a server does: a script that reads and is done ends with `await f.destroy()`, which resolves `true` for a clean stop. `fero.spawn(file, args, { stdin: 'pipe' })` starts a role as a separate `node` process and returns `{ pid, out, exited, stop, write, child }`; `stop()` is the reader's Ctrl-C and `write(line)` types a line into it. `stop()` gives up after 5 s and kills the child (`null`): a member whose survivor is stalled, or whose vote cannot complete because a third member crashed and is not yet voted out, keeps asking for up to `leave.ms` (8 s by default), and a scoped member whose new holder cannot prove it holds the copied rows drains for the whole copy window after that, up to 17.5 s in all at the default cadence, so such a stop is cut short and reads `null`, not a verdict (its rows come back from its `dir`, if it has one). The usual stop is one or two heartbeats.

Every point above is a runnable folder in the example series: [examples/README.md](examples/README.md).

## Ordering and availability, stated

fero orders one thing: one writer's writes to one row, in stamp order. There is no cross-partition ordering and no cross-partition atomicity, and no API implies one. When you need more:

1. **Model it single-partition.** The top-level key is the row and the atomicity domain. Put state that must move together under one key and write it in one assignment: one record run, one owner, atomic by construction.
2. **Use an outbox across partitions.** Write the state and an intent row in the same partition. A method, or a subscription on `.filter((o) => o.outbox)`, applies the second effect and clears the intent. Retries are safe: writes are idempotent by key, and `confirm: 'persisted'` on the first write makes the intent crash-proof before anything acts on it.
3. **Read after a cross-partition write.** To observe another client's pair, await `confirm: 'replicated'` on the first write before reading the second. Ordering is then yours, bought explicitly.

Writes need a majority. On the minority side of a split, writes wait in one bounded buffer and go through when the split heals. A node that finds its view is stale asks for the newer one; if that fails it opens its gate again and says so in the journal, rather than wedging in silence. Reads never wait: every node keeps serving its local copy, through a split and after it is voted out. Durability is explicit: `persisted` means a majority finished the fsync. Scoped mode spends memory before it risks data: a member drops a partition it no longer holds only once every current holder has confirmed it has it, and data whose holders all left is frozen and alarmed rather than lost.

## Configuration

Every option `fero(name, opts)` takes has one door: [api/config.ts](api/config.ts), the only file that imports `optcascade` (the owner's copts module, fero's one dependency: `npm install` once after a clone, Node 22.18 or later). It folds six layers into the call, highest first: `--fero.<key>` (a launch flag) > the call > `FERO_<KEY>` (a variable) > `fero.opt.ts` or `fero.opt.js` next to the nearest `package.json` at or above the working directory > `fero.opt.ts` or `fero.opt.js` in `$HOME` > the default. Inside every layer a value scoped to this resource's name beats the global one, so `--fero.shop.dir` beats `--fero.dir`, `FERO_SHOP_DIR` beats `FERO_DIR`, and `{ shop: { dir } }` beats `{ dir }` in a file.

Keys are nested lowercase words, so one spelling survives every layer. A flag nests on dots (`--fero.heartbeat.ms 250`). A variable is uppercased with `_` for the dot (`FERO_HEARTBEAT_MS=250`). A file is the object itself (`heartbeat: { ms: 250 }`), and so is the call. The old flat spellings (`heartbeatMs`, `redialMs`, `journalCap`) are refused with a pointer to the new one. A flag's key is read lowercased, as a variable's is (`--fero.Dir` and `--FERO.dir` both read as `--fero.dir`). A flag takes the next token as its value, so write a boolean or a list with `=` when the next token could be taken for a value: `--fero.server=true`, `--fero.hosts=a:1,b:2`.

The layer checks before the composer reads. An unknown key throws and names its spelling in that layer, with the nearest declared key as a hint (`unknown option 'replica' from --fero.replica, did you mean --fero.replicas`). A key that a layer may not carry throws too (`methods` from a file, `uuid` from a file, a `diag.allow` token from a flag). Values from the three text layers (flag, variable, file) are coerced: `hosts` splits on commas, `off` / `false` / `0` mean `false` for `listen`, `rendezvous` and `secret`, `1` / `true` mean `true` for `server`, an empty string means unset (the next layer down answers, so a templated `FERO_DIR=` is not a refusal), and a `uuid` or `dir` that is all digits is refused (a leading zero would be lost). The call is typed and is never coerced: `hosts: 'a,b'` or `server: 1` in code is refused as written. `server: false` from any layer pins the client role: `server: true` from a higher layer, or `listen`, `dir`, `replicas`, `data` or `methods` from any layer, then throws naming both sources. Every error names where the value came from (`(from FERO_HEARTBEAT_MS)`), and `diag(f).config()` (the internals door) lists every leaf with its value and its source, the effective defaults included.

Per-resource scoping is by the name, lowercased. It works when the name is letters and digits only (`fero('Shop')` reads the `shop` rung; a name with a dash or a space gets the global rung only) and is not itself a declared top-level name — `heartbeat`, `redial`, `leave`, `journal`, `diag`, `seams`, `uuid`, `server`, `listen`, `hosts`, `dir`, `replicas`, `rendezvous`, `secret`, `data`, `methods`, `validation`, `signals` (`fero('journal')` would read the group; a resource named `leave`, configured through its own rung, stops every resource in the process from starting, since `leave.ms` arrived). In the global rung of a flag, variable or file layer an undeclared object at the top level is another resource's subtree and is left alone, sibling names one letter apart included (`order` beside `orders`); only a near miss of a declared group that holds one of that group's own options (`heartbeats: { ms }` beside `heartbeat`, `lease: { ms }` beside `leave`) is a typo and throws; an object near a group that holds none of its options (`live: { heartbeat: … }` beside `leave`, `teams: { dir: … }` beside `seams`) is a resource, whatever its name is near, and a typo inside it is caught when that resource composes. A misspelt resource name in a scoped variable therefore sets nothing, and the door shows what was read. Two variables are stripped before the layer looks: `FERO_CONFIG` (the switch below) and `FERO_DIAG_TOKEN` (the debug viewer's: the token it presents, not one a server accepts; a server's is `FERO_DIAG_ALLOW_<NAME>`).

### The spellings

Examples for a resource named `shop`. The per-resource form is shown for the flag, the variable and the file; the call is already this resource's.

| Key | Call | Flag | Env | File (`fero.opt.ts`) | Per resource (`shop`) |
|---|---|---|---|---|---|
| `uuid` | `uuid: 'a1'` | `--fero.uuid a1` | `FERO_UUID=a1` | refused | `--fero.shop.uuid a1` · `FERO_SHOP_UUID=a1` |
| `server` | `server: true` / `false` | `--fero.server=true` / `--no-fero.server` | `FERO_SERVER=true` / `false` / `1` / `0` | `server: true` / `false` | `--fero.shop.server=true` · `FERO_SHOP_SERVER=true` · `shop: { server: true }` |
| `listen` | `listen: '127.0.0.1:4000'` / `false` | `--fero.listen 127.0.0.1:4000` / `--no-fero.listen` | `FERO_LISTEN=127.0.0.1:4000` / `off` | `listen: '127.0.0.1:4000'` | `--fero.shop.listen …` · `FERO_SHOP_LISTEN=…` · `shop: { listen }` |
| `hosts` | `hosts: ['a:1', 'b:2']` | `--fero.hosts=a:1,b:2` (or repeated) | `FERO_HOSTS=a:1,b:2` | `hosts: ['a:1', 'b:2']` | `--fero.shop.hosts …` · `FERO_SHOP_HOSTS=…` · `shop: { hosts }` |
| `dir` | `dir: './state'` | `--fero.dir ./state` | `FERO_DIR=./state` | `dir: './state'` | `--fero.shop.dir ./shop` · `FERO_SHOP_DIR=./shop` · `shop: { dir: './shop' }` |
| `heartbeat.ms` | `heartbeat: { ms: 250 }` | `--fero.heartbeat.ms 250` | `FERO_HEARTBEAT_MS=250` | `heartbeat: { ms: 250 }` | `--fero.shop.heartbeat.ms 250` · `FERO_SHOP_HEARTBEAT_MS=250` · `shop: { heartbeat: { ms: 250 } }` |
| `redial.ms` | `redial: { ms: 200 }` | `--fero.redial.ms 200` | `FERO_REDIAL_MS=200` | `redial: { ms: 200 }` | `--fero.shop.redial.ms 200` · `FERO_SHOP_REDIAL_MS=200` · `shop: { redial: { ms: 200 } }` |
| `redial.tries` | `redial: { tries: 5 }` | `--fero.redial.tries 5` | `FERO_REDIAL_TRIES=5` | `redial: { tries: 5 }` | `--fero.shop.redial.tries 5` · `FERO_SHOP_REDIAL_TRIES=5` · `shop: { redial: { tries: 5 } }` |
| `leave.ms` | `leave: { ms: 30000 }` | `--fero.leave.ms 30000` | `FERO_LEAVE_MS=30000` | `leave: { ms: 30000 }` | `--fero.shop.leave.ms 30000` · `FERO_SHOP_LEAVE_MS=30000` · `shop: { leave: { ms: 30000 } }` |
| `journal.cap` | `journal: { cap: 65536 }` | `--fero.journal.cap 65536` | `FERO_JOURNAL_CAP=65536` | `journal: { cap: 65536 }` | `--fero.shop.journal.cap 65536` · `FERO_SHOP_JOURNAL_CAP=65536` · `shop: { journal: { cap: 65536 } }` |
| `replicas` | `replicas: 3` | `--fero.replicas 3` | `FERO_REPLICAS=3` | `replicas: 3` | `--fero.shop.replicas 3` · `FERO_SHOP_REPLICAS=3` · `shop: { replicas: 3 }` |
| `rendezvous` | `rendezvous: '127.0.0.1:4000'` / `false` | `--fero.rendezvous …` / `--no-fero.rendezvous` | `FERO_RENDEZVOUS=…` / `off` | `rendezvous: '…'` | `--fero.shop.rendezvous …` · `FERO_SHOP_RENDEZVOUS=…` · `shop: { rendezvous }` |
| `diag.allow` | `diag: { allow: { ops: 'tok' } }` | refused | `FERO_DIAG_ALLOW_OPS=tok` | `diag: { allow: { ops: 'tok' } }` | `FERO_SHOP_DIAG_ALLOW_OPS=tok` · `shop: { diag: { allow: { ops: 'tok' } } }` |
| `secret` | `secret: 'sixteen characters or more'` / `false` | refused | `FERO_SECRET=…` / `off` | `secret: '…'` | `FERO_SHOP_SECRET=…` · `shop: { secret: '…' }` |
| `secret.client` | `secret: { client: '…' }` | refused | `FERO_SECRET_CLIENT=…` | `secret: { client: '…' }` | `FERO_SHOP_SECRET_CLIENT=…` · `shop: { secret: { client: '…' } }` |
| `data` | `data: { … }` | refused | refused | `data: { … }` | `shop: { data: { … } }` |
| `methods` | `methods: { … }` | refused | refused | refused | the call only |
| `validation` | `validation: rule` | refused | refused | refused | the call only |
| `seams.validation` | `seams: { validation: rule }`, the old spelling of `validation` | refused | refused | refused | the call only |
| `signals` | `signals: false` | refused | refused | refused | the call only |

### The table

Scope: *instance* = this node only. *cluster* = must be the same on every member. Every server says its cluster values (`heartbeat.ms`, `replicas`, `methods`, the `validation` rule's text, the ring) in the first frame it sends, and two servers whose values differ refuse to link, naming the key that differs in both journals (`contractReject`). So a rolling change of a cluster key splits the cluster until every member runs the new value: stop every member and client, change the value, start them again. *process* = one value for the whole process. Every default is the code's.

**Identity and role**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `uuid` | the dir's saved identity, else 8 random hex chars | instance | call, flag, env. Never a file: one shared file would give every process the same identity | Names this node. It rides HELLO and stamps every write this node makes. Must be unique per member. On a durable `dir` it must match the saved identity, or `fero()` throws. A value that is all digits is refused from a flag or a variable. |
| `server` | unset: a bare `fero(name)` is a client | instance | call, flag, env, file | `true` pins the server role with no other marker (a free loopback port, registered with the directory). `false` pins the client role: then `listen`, `dir`, `replicas`, `data` or `methods` from any layer throws naming both sources. Any of those five markers also makes a server on its own. |
| `data` | unset | instance | call, file | Initial rows, applied only when the local fold is empty at boot. A restore or replayed state never re-seeds. Implies the server role. |

**Network and discovery**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `listen` | server: `127.0.0.1:0` (a free loopback port); client: none | instance | call, flag, env, file | The address this node binds and tells its peers. `false` (or `off`, `--no-fero.listen`) is the socketless solo node: it serves nothing, dials nothing and meets no directory. When this node's address would leave the box (its `hosts` name another box, or its `rendezvous` is not loopback), the listen must be an address another box can dial: a loopback or wildcard listen, the default included, is refused with "to be reachable from another box, listen on a routable address". A user resource may never take the directory's socket. |
| `hosts` | unset: the directory's discovered set alone | instance | call, flag, env, file | Static addresses to dial on start. Alone on a client they are its feeders; beside a server marker they make a dialing member. The directory's discovered set is unioned in. An entry with no port (`hosts: ['10.0.0.5']`) names another box: this node asks that box's directory, at its own rendezvous port, for the name, and dials what it lists. It only asks: it never registers or hosts there, and `cluster.me.rendezvous.boxes` shows each asked box as up or down. That box's directory must listen where other boxes can reach it (`FERO_RENDEZVOUS=10.0.0.5:3376` on that box). A bare host is refused with the directory off. A comma-separated string is split from a flag or a variable. |
| `rendezvous` | unset, then `FERO_RENDEZVOUS`, then `127.0.0.1:3376` | instance (the variable is process-wide) | call, flag, env, file | The per-box directory this instance registers with and looks names up in (V4-3). `false` (or `off`, `--no-fero.rendezvous`) means no directory at all. Instances on one box that name different directories never find each other. Instances in one process that meet the same directory at the same `heartbeat.ms` and `redial.ms` share one directory client (one link to it); the last one stopped closes it. The directory host closes a client link that is silent for 20 of its heartbeats (10 s at the default), so a hung process's entry goes; a live one is never closed, whatever its own heartbeat. A failed lookup is asked again with backoff, and `cluster.me.rendezvous.error` keeps each part's trouble until that part recovers. `FERO_RENDEZVOUS` is read even with the layer off: it sets the process default and never overrides an explicit key. |

**Durability**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `dir` | unset: memory only | instance | call, flag, env, file | The directory holding `wal.log` and `boot.json` (and, after a boot record failed, a `condemned` marker that refuses the next restart). Its presence turns on the WAL, restores the previous life's identity and view, and implies the server role. One dir is one node of one resource; two resources in one process want the per-resource form (`FERO_SHOP_DIR`, `FERO_USERS_DIR`). |

**Replication**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `replicas` | unset: every member holds every partition | cluster | call, flag, env, file | Scoped replication (M6): each partition lives on exactly this many holders. An integer of 1 or more. Implies the server role. Must be the same on every member. A holder's clean stop waits for its partitions to be copied to their new holders, up to 16 heartbeats (the kernel tune row `drainTicks`: 8 s at the default cadence, so a slow drain outlasts `fero.spawn`'s 5 s stop grace, and the whole stop — the knock window `leave.ms`, the drain and the shell's three-tick grace — can run past `docker stop`'s 10 s, up to 17.5 s when the survivor was stalled too); `destroy()` resolves `false` past that, or when it is the last member and nobody is left to copy to, and `cluster.me.undrained` says how many partitions went with it. The count covers the copy window only: a stop whose vote never came back (four heartbeats with no member connected, `leave.ms` with one) goes like a crash, copies nothing and counts nothing. |

**Membership and timing**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `heartbeat.ms` | `500` (`0` = off) | cluster | call, flag, env, file | The one clock. Pings, membership ticks, the write retry clock, compaction and WAL snapshot arming all run on it. `0` turns heartbeats off (an explicit protocol mode, the sim's sweep mode). A finite number of milliseconds, 0 or more. Must be the same on every member. |
| `redial.ms` | `100` | instance | call, flag, env, file | The dial backoff base after a peer drops. It doubles per failure up to 32 times the base; `redial.tries` says when it gives up. Also the `#directory` client's redial base. A finite number of milliseconds, 0 or more. |
| `redial.tries` | `10` | instance | call, flag, env, file | How many times a dropped peer is dialed before the chain gives up (heartbeats revive it). A dead member is dialed 5 times (that chain is the eviction clock: about four seconds at the default base), or this many if that is lower. Not passed to the `#directory` client. An integer, 0 or more. |
| `leave.ms` | `8000` (16 heartbeats at the default cadence) | instance | call, flag, env, file | The knock window: how long a clean stop keeps asking a connected member to vote it out. A leaver asks every heartbeat; while it is connected to a member that is not itself leaving it keeps asking for up to this long, so a survivor that is stalled for a few seconds (a long pause, a swap-in) still reads the request and votes, and the stop is clean. With no such member connected the leaver waits four heartbeats and goes, as before. A number of milliseconds, 0 or more; the kernel counts it in heartbeats, rounded up (the tune row `leaveWindow`), and never less than four, so `0` means the four-heartbeat bound alone. The shell's stop cap follows it: this window plus two heartbeats, plus the drain on a scoped member. A survivor stalled longer than the window still sees a crash. |

**Bounds**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `journal.cap` | `4096` | instance | call, flag, env, file | The size of the diagnostics ring. Older events are dropped and counted. Raise it for captures that want full time travel. A tiny cap is a bad idea: one step can emit more events than it holds, so the debugger loses its diary and `cluster.partitions.acquired` can undercount. It never costs correctness: when the ring overflows past what the cluster view has read, the view is rebuilt from live state. An integer of 1 or more. |

**Method plane**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `methods` | unset: an open resource | instance | the call only | The hosted methods, and the door (V4-5): declaring them means clients change data only through them. A plain object of functions. Never from another layer: it would host code and close the door from outside the source line. `methods: {}` is a resource clients may only read. Implies the server role. |
| `validation` | unset: every write admitted | cluster | the call only | A schema check on every record at the one local ingest (the server's own writes, its handlers', the `data:` seed), and on an open server at the relay for client writes. Return `true` to admit or a reason string to refuse. A function, so no other layer can carry it. Every server should run the same rule. |
| `seams.validation` | unset | cluster | the call only | The old spelling of `validation`. It still works in this release and prints a one-line note to stderr once per process; it goes in the next. Setting both is refused. |

**The door**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `secret` | unset: the open door | cluster: the same value on every member; a client holds it or `secret.client` | call, env, file. Never a flag: `ps`, `/proc/<pid>/cmdline` and shell history show every flag | The cluster's shared secret: text of at least 16 characters (`openssl rand -base64 24` prints a good one). With it set, a peer must prove it holds the secret before it is admitted: an HMAC over fresh nonces on every link, the dialer first ([docs/DESIGN-DOOR.md](docs/DESIGN-DOOR.md)). A process with neither it nor the client key cannot join, read, write, call a method or vote. Both ends print one line per peer and reason on stderr (`fero('shop'): refused 127.0.0.1:4100 — its secret differs from this node's`), and both journals carry `doorReject` with the reason. A server that listens off loopback (anything but `127.*`, `localhost`, `[::1]`) must set it, or say `secret: false` (`FERO_SECRET=off`) to run open on purpose; a client is never refused for having none. Put a literal secret in `$HOME/fero.opt.ts` or the environment, never in a committed project file; a child process inherits the variable. `diag(f).config()` shows `<set>` and the source, never the value; no journal row, capture or message ever carries it. The limits, said plainly: a client that holds the secret is a member on the wire (it can drop its client role and vote), so give clients the client key instead (`secret.client`, the next row); a leaked secret is a member; changing the secret, or any cluster key, is a full stop and start of every member and client (there is no rotation window yet; the client key changes with the secret); every frame after the handshake is cleartext, so use a private network, WireGuard or SSH (TLS at the shell is a later layer); a process at an address you typed in `hosts` can relay the handshake to a real member and be admitted as the peer it relays for (the address rule covers only addresses the directory or a view gave; TLS later). The `#directory` stays open on loopback and never carries a secret. |
| `secret.client` | unset | cluster: the same value on every client that holds it | call, env, file. Never a flag | The derived client key: `HMAC-SHA256(secret, 'fero/client/1')` as base64url, 43 characters. A process that holds it and not the secret is a **client that can only follow**: it is admitted as a client after a client-key proof, is fed, can write and call methods as any client can, and can never become a member — a HELLO without the client role is checked with the secret and refused `bad-proof` on the spot, so it cannot vote, write another lane, leave a member out or take a member's uuid. A member derives the key from its secret and checks every client with it; a client that holds the secret keeps working. A server with only the client key is refused at `fero()`. A process holds one of the two, never both: setting `secret` and `secret.client` together, from any two layers, is refused naming both sources. Print it once from the secret with `fero.clientKey(secret)` (`node --input-type=module -e "import { fero } from 'fero'; console.log(fero.clientKey(process.env.FERO_SECRET))"`) or from a shell with `printf 'fero/client/1' \| openssl dgst -sha256 -hmac "$FERO_SECRET" -binary \| openssl base64 -A \| tr '+/' '-_' \| tr -d '='` (the same string; the secret shows in `ps` while openssl runs). `diag(f).config()` shows `<set>` and the source, never the value. **What it does not do**, said plainly: a client-key holder can pose as a server to another client that dials it, because a client can only check client-key proofs (a member is never fooled this way: it checks every non-client proof with the secret). The directory and the address rule limit where that is reachable (on the default box the directory is loopback; a routable rendezvous or a typed host is your explicit act); closing it needs a key a client can check but not make (a server signing key, later) or TLS at the shell. The client key is shared by every client, so a leaked one is a client; there is no per-client identity. |

**Diagnostics**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `diag.allow` | unset: the channel is dead, every attach is denied | instance | call, env, file. Never a flag: every user on the box can read a command line | Who may attach the debugger to this node (`npm run debug -- --attach host:port`, M7): a name for each token, `{ ops: 'tok' }`. The viewer presents its token from `FERO_DIAG_TOKEN`; the names land in the node's journal, the tokens never do. `diag(f).config()` shows the names and `[redacted]` for each token. In a variable the name is one word of letters and digits (`FERO_DIAG_ALLOW_OPSTEAM`: an `_` would nest it), and a token that reads as a number or a boolean (`0123`, `1e5`, `true`) is refused, since its text would be lost. The allow that wins (a higher layer, or the name's own rung) replaces the others whole, not name by name. A flag is refused by each process that composes the name it is scoped to. The token crosses the wire in clear text: attach on a trusted network or through a tunnel. |

**Process**

| Key | Default | Scope | Set via | What it does |
|---|---|---|---|---|
| `signals` | `true` | process (one listener; opted out per instance) | the call only | Ctrl-C and SIGTERM make every live instance leave cleanly, then the process exits 0 unless the app has its own listener (V4-8). `false` keeps this instance out: stop it yourself. Call only, because the clean stop is per instance and a variable or a file would make it per process. |
| `FERO_CONFIG` (a switch, not a key) | on | process | env only: `FERO_CONFIG=off` | Turns the layer off. `fero()` then reads the call alone and makes zero `optcascade` calls: no flag parse, no environment walk, no file probe. `off`, `on` and unset are the only values; anything else throws. The test battery sets it (below). |

### Kept fixed

Everything else stays a constant on purpose: the wire format, the ring hash, the quorum thresholds, the write and call timeouts, the on-disk names, and every sim and tooling literal. Each has a reason (a member with a different value would drop frames, compute a different owner, or mean a different thing by "confirmed"). The full list, with the reason per row, is [docs/DESIGN-CONFIG.md](docs/DESIGN-CONFIG.md) section 5. The membership tick counts, the write pipeline bounds, the redial curve and the member chain are rows of the kernel tune table ([kernel/tune.ts](kernel/tune.ts)): one frozen object per node, defaults equal to the old constants, every read site reading a row. Two rows have a `fero()` key today: `redial.tries` (`redials`) and `leave.ms` (`leaveWindow`, in heartbeats).

### For the test battery

Every suite runs with the layer off. [utils/battery.ts](utils/battery.ts) sets `FERO_CONFIG=off` and `FERO_RENDEZVOUS=off` (plain assignment: the pins win over whatever the shell exports); the `npm test` and `npm run perf` scripts pass it as `--import ./utils/battery.ts`, and every suite that composes a real `fero()` imports it first, so a single-file `node --test` runs under the same two pins. With the layer off no `--fero.*` flag, no `FERO_*` variable, and no `fero.opt.ts` in the checkout or in `$HOME` can reach a test. With the directory off an explicit-topology test never meets a live box directory. The layer's own suites inject their sources explicitly ([api/config.test.ts](api/config.test.ts)) or spawn children with `FERO_CONFIG` deleted ([tests/config.test.ts](tests/config.test.ts)); discovery tests opt in with a free rendezvous port each. Children spawned with `process.env` inherit both pins, so the example checks are pinned by the environment alone. A test also asserts that the checkout holds no `fero.opt.*` (a file at the repo root would reach every hand-run example), that `package-lock.json` pins `optcascade`, and that this section names every key.

### A `fero.opt.ts`

A default export. The top level is the global rung; a subtree named after a resource is that resource's rung and beats it. Files load once per process through `require()`, so a file must use erasable TypeScript only (no enums, no top-level `await`); a file that fails to load throws with its path.

```ts
// fero.opt.ts, next to package.json (or in $HOME for every project)
export default {
    heartbeat: { ms: 250 },              // every resource in this project
    rendezvous: '127.0.0.1:4000',        // this project's own directory
    shop: {                              // fero('shop') only
        dir: './state/shop',
        journal: { cap: 65536 },
    },
    users: {                             // fero('users') only
        dir: './state/users',
        replicas: 2,
    },
}
```

With that file, `node server.ts` gives `fero('shop')` its dir and a bigger journal, `fero('users')` its own dir and scoped replication, and both the shared heartbeat and directory. `node server.ts --fero.shop.dir /tmp/x` beats the file for `shop` alone; `FERO_HEARTBEAT_MS=100` beats the file for every resource but loses to a value in the call.


## The debugger

Every kernel event is a row in one typed journal. A capture is the journals, the per-writer logs, the end state and the link tables of a run, and it carries its own event vocabulary, so it describes itself. [tools/debug/model.mjs](tools/debug/model.mjs) folds a capture into four views. Where each write went, and what happened to it at every node. Which cells saw a real election between writers. The state at any point in time. And a replay check: the fold must reproduce every node's captured end state before the page paints it. [viewer.html](tools/debug/viewer.html) shows all of that: a filterable tree, an inspector, one filter box, a time-travel scrubber, and a plain-English tooltip on every label. The scenario dashboard (`npm run debug`, served at `/`) runs the registry and shows each behaviour as a measured card with deltas against the pinned baseline. `--live` runs a real 5-node cluster inside the debugger's process. `--attach h:p,…` reads running nodes that were given a DIAG token; no `fero()` key sets one yet, so today that means nodes built by the tools. `npm run shrink` reduces a failing seed to a minimal schedule frozen at the violating event. Everything renders folded facts only: absence shows as absence, a truncated journal switches time travel off and marks the node `truncated`, and a node that will not answer is an `absent` row, never an invented card. Rungs 20 to 23 of the example series walk through it.

## Testing policy

Every test passes or is quarantined with a reason, a pointer, and the condition that lifts the quarantine. Two skips are sanctioned without a ticket: the absolute perf tier on a box whose fingerprint did not pin the baseline, and a real-socket probe that declared its own run invalid. A flake is reproduced under seed sweep and classified before other work continues, and a real-socket failure is reproduced as a sim fault before its fix merges. Performance is a hard requirement: a change is done when its tests and its perf pins are green, and a threshold is never widened to make a pin pass ([tools/perf/BASELINE.md](tools/perf/BASELINE.md)).

## Layout

```
api/       the public surface: fero(name, opts) → { name, data, methods, cluster, snapshot, destroy }
  index.ts      the composer: roles by declared act, the config checks, methods: as the door, the cluster fold
  data.ts       the binding: the lens in, the confirmed fold out, the write outcomes (cluster.writes)
  substrate.ts  the ONE seam onto ../data — nothing else in fero imports data
  config.ts     the ONE seam onto optcascade — nothing else reads argv, FERO_* or fero.opt.*
  methods.ts    the method plane: the host (flush-on-return) and the caller (handles, failover)
  directory.ts  the per-box #directory: register, lookup, host takeover, one client per process, hung-client expiry
  spawn.ts      fero.spawn · signals.ts the Ctrl-C registry · diagnostics.ts the Symbol-keyed internals door
  types.ts      the exported types
kernel/    the deterministic core: no I/O, no ambient time or randomness (purity.test.ts enforces it)
  node.ts (step(event) → effects, the ONE stamp site) · write.ts (the one write ingress) · membership.ts · ring.ts · confirm.ts · log.ts · streams.ts · scope.ts · codec.ts · link.ts · journal.ts · diag.ts · env.ts
shell/     the TCP + timer + fsync-WAL runtime around the kernel; no protocol decisions
sim/       the executive: virtual time, seeded faults, per-event monitors, the sweep, the shrinker, the n≈100 scale tier
tests/     cross-layer scenarios, the real-socket and real-WAL tiers, the example checks, the config tier, the baseline gate
tools/     debug/ (capture → model → viewer, the scenario dashboard, live and attach) · perf/ (the persisted absolute baseline)
utils/     shared helpers (#utils); battery.ts pins the test battery: directory off, config layer off
examples/  the 28-rung series: one folder per example, one file per terminal, a check.ts that proves it
docs/      the decisions ledger, the design records, the history
```

Source-served, no build: everything runs with `--experimental-strip-types` (Node 22.18 or later; Node 23.6 or later needs no flag).

## The record

- [STATUS.md](STATUS.md) — one page: where things stand, the open bugs, what is worth doing, what has been decided.
- [docs/DECISIONS.md](docs/DECISIONS.md) — every settled decision in full, append-only.
- [docs/HISTORY.md](docs/HISTORY.md) — the milestone record, from the v3 kernel to the example series.
- [docs/DESIGN-M6.md](docs/DESIGN-M6.md) scoped replication · [DESIGN-M7.md](docs/DESIGN-M7.md) the debugger and the DIAG channel · [DESIGN-DIRECTORY.md](docs/DESIGN-DIRECTORY.md) the per-box directory · [DESIGN-CONFIG.md](docs/DESIGN-CONFIG.md) the config layer · [CHECKPOINT.md](docs/CHECKPOINT.md) the pre-M4 re-plan.
- [CLAUDE.md](CLAUDE.md) — the guide for agent sessions.
