# fero examples

A graded series. Every example is one folder you can copy (plus `lib.ts`): the files a README names
are the terminals you open, and `node check.ts` proves the example. No build, no flags — Node 22.18+
or 23.6+ runs the `.ts` files as they are.

| # | Example | The one lesson | Terminals |
|---|---|---|---|
| 01 | [two-servers](01-two-servers/) | one file, run twice, is a replicated object; stop one and the other carries on alone | `node server.ts` ×2 |
| 02 | [server-client](02-server-client/) | a seed makes a server; a bare `fero(name)` follows it and writes back | `node server.ts` · `node client.ts` |

Three rules every example keeps:

1. **Rows live at the top level.** The top-level key is the row and the partition (the single-writer
   atomicity domain); operators chain from the root view only.
2. **One write style per subtree.** Whole rows or leaves — never both on one row.
3. **`destroy()` is the exit.** Ctrl-C runs it; without it a fero process never ends. It leaves cleanly:
   the view shrinks by a ballot before the sockets close, so a clean stop is never mistaken for a crash.

How a check works: `check.ts` runs the role files as child processes with `FERO_EXAMPLE_TICKS` set so
they stop by themselves, reads what they print, asserts, and ends with `ok <example>`. A check meets its
own private directory (a free port), never the box's, so it can run while your terminals are up. The
smoke test `tests/examples.test.ts` runs every `check.ts` the same way inside `npm test`.
