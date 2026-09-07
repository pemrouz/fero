# fero examples

A graded series. Every example is one folder you can copy (plus `lib.ts`): the files a README names
are the terminals you open, and `node check.ts` proves the example. No build, no flags — Node 22.18+
or 23.6+ runs the `.ts` files as they are.

| # | Example | The one lesson | Terminals |
|---|---|---|---|
| 01 | [three-servers](01-three-servers/) | one file, run three times, is a replicated object that survives losing one | `node server.ts` ×3 |

Three rules every example keeps:

1. **Rows live at the top level.** The top-level key is the row and the partition (the single-writer
   atomicity domain); operators chain from the root view only.
2. **One write style per subtree.** Whole rows or leaves — never both on one row.
3. **`destroy()` is the exit.** Ctrl-C runs it; without it a fero process never ends. It leaves cleanly:
   the view shrinks by a ballot before the sockets close, so a clean stop is never mistaken for a crash.

How a check works: `check.ts` runs the role files as child processes with `FERO_EXAMPLE_TICKS` set so
they stop by themselves, reads what they print, asserts, and ends with `ok <example>`. The smoke test
`tests/examples.test.ts` runs every `check.ts` under a private directory port inside `npm test`.
