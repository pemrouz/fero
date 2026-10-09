# fero examples

A graded series. Every example is one folder you can copy (plus `lib.ts`): the files a README names
are the terminals you open, and `node check.ts` proves the example. No build, no flags — Node 22.18+
or 23.6+ runs the `.ts` files as they are, after one `npm install` at the repo root (fero's one
dependency).

| # | Example | The one lesson | Terminals |
|---|---|---|---|
| 01 | [two-servers](01-two-servers/) | one file, run twice, is one replicated object; Ctrl-C one and the other carries on | `node server.ts` ×2 |
| 02 | [server-client](02-server-client/) | a seed makes a server; a bare `fero(name)` finds it by name, follows it, and writes back | `node server.ts` · `node client.ts` |
| 03 | [one-write](03-one-write/) | a client's write is a request: a `pending` row until a server stamps it; only then does it show, on both screens | `node client.ts` · `node server.ts` |
| 04 | [rows](04-rows/) | a write is a record (type, key, value) you can watch land; a row is written whole or by its fields, never both; a refused write never lands | `node server.ts` |
| 05 | [views](05-views/) | an operator on `f.data` is a live view: it prints itself once, then only when a write moves a row across its edge or rewrites one it holds | `node server.ts` |
| 06 | [numbers](06-numbers/) | a sale is a new row, never edited; `sum`, `avg`, `median`… are live numbers folded from the rows — tap one, never read-modify-write a total | `node server.ts` |
| 07 | [ordered](07-ordered/) | a sorted view is an array in rank order: by a column, by a comparator with a tiebreak, the top n; a bounded window rotates in one batch | `node server.ts` |
| 08 | [methods](08-methods/) | a function under `methods:` runs on the server: a client awaits it, the reply follows the commit, and declaring them is the door | `node server.ts` · `node client.ts` |
| 09 | [live](09-live/) | a method that returns a view streams: `await` it for a snapshot, `.open()` it for a live mirror the operators chain on; `close()` ends it | `node server.ts` · `node client.ts` |
| 10 | [confirm](10-confirm/) | the same write awaited at three rungs — committed, replicated, persisted; the reply names the rung it PROVED, and a reject is how far it got, never a rollback | `node server.ts` ×2 · `node client.ts` |
| 11 | [validation](11-validation/) | `validation:` is one rule for every write that enters a server — the seed, its own, a client's; a refused write never shows, only a `rejected` row of `cluster.writes` with the reason | `node server.ts` · `node client.ts` |
| 12 | [durable](12-durable/) | `dir` makes the node durable: run the file again and it is the SAME node in its next life (`~2`), its rows back before it has a socket; the seed applies once; a solo `persisted` is one disk | `node server.ts` ×2 |
| 13 | [cluster-of-three](13-cluster-of-three/) | three members on fixed addresses with disks: kill one, the two left vote it out in about a second and still prove `persisted` on two disks, and the same command brings the dead one back as itself from its disk | `node server.ts 4801` · `node server.ts 4802` · `node server.ts 4803` · `node client.ts` |
| 14 | [failover](14-failover/) | `kill -9` the server feeding a client: its `peers` drops at once, its live handle re-subscribes by itself, its next write commits on a survivor (after the vote if the dead one stamped that row), and a call in flight fails fast unless `{ retry: true }` | `node server.ts` ×3 · `node client.ts` |
| 15 | [static-topology](15-static-topology/) | with the directory off every address is in the call — a member is `listen` + `hosts`, a client is `hosts` — and a shape that cannot work is refused at `fero()` | `node server.ts 4801 4802 4803` ×3, rotated · `node client.ts 4801 4802 4803` · `node refusals.ts` |
| 16 | [scoped](16-scoped/) | `replicas: 2` puts every row on exactly two members: a shard is never shown as the resource — a sync read or an operator throws typed, `await f.data` gathers the whole, a row not held is one hop away, and a client reads the union | `node server.ts 4811 5811 6811` ×3 rotated · `node client.ts 4811 5811 6811` |
| 17 | [lww-honesty](17-lww-honesty/) | two members read a cell and write it back plus one, and one increment is lost — a cell keeps its last writer; write one row per event and fold them instead | `node race.ts` |
| 18 | [secret](18-secret/) | `FERO_SECRET` in the environment is the cluster's shared secret, never a flag or the call: two members that hold it form a cluster; a third started without it is refused at the door, both screens say why once per peer, and nothing of it lands; the same command with the secret joins | `FERO_SECRET=… node server.ts 4801 4802` ×2, rotated · `node server.ts 4803 4801 4802`, then with the secret |
| 20 | [inside](20-inside/) | every instance carries a diagnostics handle off the typed surface: the journal, the log, compaction on demand, and a capture file the debugger opens | `node inside.ts` · `npm run debug -- …` |
| 21 | [journal](21-journal/) | `diag(f).journal(from)` is a cursor over the kernel's one diagnostics ring: tail it and watch a peer arrive and be voted in, leave by vote, and its link close | `node server.ts` ×2 |
| 22 | [time-travel](22-time-travel/) | a capture with a story: two writes before the first view are an election (`lww-lost` in the viewer), the same two after it are plain history, a cut heals by anti-entropy, and the scrubber replays any step | `node story.ts` · `npm run debug -- examples/22-time-travel/story.capture.json` |
| 23 | [live](23-live/) | a running cluster writes a `kind: 'live'` capture file once a second (temp file, then rename) and `npm run debug -- <file>` polls it: the debugger follows a real fero process on this box with no wire attach | `node live.ts` · `npm run debug -- examples/23-live/live.capture.json` |
| 30 | [fleet-audit](30-fleet-audit/) | real processes, real disks, real `kill -9`: three durable members, sensors writing facts through the door with receipts, a live dashboard, one member killed and then all three, restored from disk — then an audit: the members agree, every `persisted` receipt is on every member, no phantom rows, and a reject is not a rollback | `node fleet.ts` · `node dashboard.ts` |
| 40 | [chat](40-chat/) | a chat is facts plus one sorted view: `post` runs on the server, throws its rule for every joiner and stamps who (`ctx.peer`) and when; every screen sorts the rows itself with a tiebreak, so they all agree | `node room.ts general` · `node join.ts general ada` · `node join.ts general bob` |
| 41 | [kanban](41-kanban/) | a card is a row written by its fields: two editors change two fields of one card at once and both land; one rule, carried by the board and every editor, refuses a whole row or an unknown column — an editor refuses its own before it leaves | `node board.ts` · `node edit.ts ada` · `node edit.ts bob` |
| 42 | [web-bridge](42-web-bridge/) | fero speaks TCP, so a browser reaches a resource through a Node bridge that is a bare client: `connect` records streamed to each tab as events, a form post written as a whole row | `node server.ts` · `node web.ts 8080` |
| 43 | [ledger](43-ledger/) | money is facts: transfers are rows on three durable members, the rule thrown from a method, the intent cleared through the door, every id on a member that comes back | `node member.ts 4901` ×3 (4902, 4903) · `node notifier.ts` · `node teller.ts mint alice 100` |
| 44 | [sell](44-sell/) | an open server lets every client change every row, the price included; declaring `methods:` is the door: the same write is refused `methods-only`, and `sell` writes the sale at the server's price | `node open.ts`, then `node door.ts` · `node customer.ts` ×2 |

Four tiers: 01-18 climb one feature at a time, 20-23 open the debugger, 30 is everything at once on one
box, and 40-44 are apps, the last of them the story the website tells: an open shop anyone can change,
then the same shop behind a door.

Three rules every example keeps:

1. **Rows live at the top level.** The top-level key is the row (one writer per row); operators chain
   from the root view only.
2. **One write style per subtree, by preference.** Whole rows or single fields. Mixing them on one row
   is safe since V4-18 (the newer stamp wins across depth: a whole-row write hides every older field
   write, a newer field write shows on top of the row), but a reader of a role file should not have to
   work that out, so the examples keep to one style per row.
3. **Ctrl-C is the exit.** fero stops cleanly by itself: it leaves the group by a vote before the sockets
   close, so a clean stop is never mistaken for a crash. `destroy()` is the same thing in code.

A screen is one line per change, or one frame redrawn after `console.clear()` and headed by the role
word in CAPS (`SHOP`, `CHAT`). A role that also reads what you type (40's `join.ts`, 41's `edit.ts`)
gives its readline the screen too and ends every frame with `rl.prevRows = 0; rl.prompt(true)`, so a
half-typed line comes back after a redraw. The `prevRows = 0` says the line starts on a fresh row: the
screen was just cleared, and without it a line wider than the terminal would climb back over the
frame. That readline then owns Ctrl-C, so it hands it on to fero's clean stop:
`rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))`. `tests/examples-tty.test.ts` checks both
roles on a real terminal.

Every option a role file could pass in the call can also come from outside the file: a flag
(`node server.ts --fero.dir ./shop`), a variable (`FERO_DIR=./shop node server.ts`), or a `fero.opt.ts`
next to the nearest `package.json` or in your home directory. The README's "Configuration" section has
the table. The role files here stay bare on purpose. The files that read their ports from the command
line — 13's and 18's `server.ts`, 15's and 16's `server.ts` and `client.ts`, 30's and 43's `member.ts` — take
every argument as a port, so give those the variable form: `FERO_HEARTBEAT_MS=50 node client.ts 4801`, not a
flag. A secret is never a flag: use the variable form (`FERO_SECRET=… node server.ts`, 18) or a `fero.opt.ts`
in your home directory; `--fero.secret` is refused.

How a check works: `check.ts` starts the role files with `fero.spawn` (each a separate `node <file>`, its
output echoed here), reads what they print, asserts, stops them with Ctrl-C (`stop()`), and ends with
`ok <example>`. Close your terminals of that example first: by hand a check meets the box directory like
everything else. `tests/examples.test.ts` runs every `check.ts` the same way inside `npm test`, each on
a private directory.
