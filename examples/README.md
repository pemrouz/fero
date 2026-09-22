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
| 11 | [validation](11-validation/) | `seams.validation` is one rule for every write that enters a server — the seed, its own, a client's; a refused write never shows, only a `rejected` row of `cluster.writes` with the reason | `node server.ts` · `node client.ts` |
| 12 | [durable](12-durable/) | `dir` makes the node durable: run the file again and it is the SAME node in its next life (`~2`), its rows back before it has a socket; the seed applies once; a solo `persisted` is one disk | `node server.ts` ×2 |
| 13 | [cluster-of-three](13-cluster-of-three/) | three members on fixed addresses with disks: kill one, the two left vote it out in six seconds and still prove `persisted` on two disks, and the same command brings the dead one back as itself from its disk | `node server.ts 4801` · `node server.ts 4802` · `node server.ts 4803` · `node client.ts` |
| 14 | [failover](14-failover/) | `kill -9` the server feeding a client: its `peers` drops at once, its live handle re-subscribes by itself, its next write commits on a survivor (after the vote if the dead one stamped that row), and a call in flight fails fast unless `{ retry: true }` | `node server.ts` ×3 · `node client.ts` |
| 15 | [static-topology](15-static-topology/) | with the directory off every address is in the call — a member is `listen` + `hosts`, a client is `hosts` — and a shape that cannot work is refused at `fero()` | `node server.ts 4801 4802 4803` ×3, rotated · `node client.ts 4801 4802 4803` · `node refusals.ts` |
| 16 | [scoped](16-scoped/) | `replicas: 2` puts every row on exactly two members: a shard is never shown as the resource — a sync read or an operator throws typed, `await f.data` gathers the whole, a row not held is one hop away, and a client reads the union | `node server.ts 4811 5811 6811` ×3 rotated · `node client.ts 4811 5811 6811` |
| 17 | [lww-honesty](17-lww-honesty/) | two members read a cell and write it back plus one, and one increment is lost — a cell keeps its last writer; write one row per event and fold them instead | `node race.ts` |
| 20 | [inside](20-inside/) | every instance carries a diagnostics handle off the typed surface: the journal, the log, compaction on demand, and a capture file the debugger opens | `node inside.ts` · `npm run debug -- …` |
| 21 | [journal](21-journal/) | `diag(f).journal(from)` is a cursor over the kernel's one diagnostics ring: tail it and watch a peer arrive and be voted in, leave by vote, and its link close | `node server.ts` ×2 |

Three rules every example keeps:

1. **Rows live at the top level.** The top-level key is the row (one writer per row); operators chain
   from the root view only.
2. **One write style per subtree.** Whole rows or single fields — never both on one row.
3. **Ctrl-C is the exit.** fero stops cleanly by itself: it leaves the group by a vote before the sockets
   close, so a clean stop is never mistaken for a crash. `destroy()` is the same thing in code.

Every option a role file could pass in the call can also come from outside the file: a flag
(`node server.ts --fero.dir ./shop`), a variable (`FERO_DIR=./shop node server.ts`), or a `fero.opt.ts`
next to the nearest `package.json` or in your home directory. The README's "Configuration" section has
the table. The role files here stay bare on purpose.

How a check works: `check.ts` starts the role files with `fero.spawn` (each a separate `node <file>`, its
output echoed here), reads what they print, asserts, stops them with Ctrl-C (`stop()`), and ends with
`ok <example>`. Close your terminals of that example first: by hand a check meets the box directory like
everything else. `tests/examples.test.ts` runs every `check.ts` the same way inside `npm test`, each on
a private directory.
