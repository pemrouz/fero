# fero examples

A graded series. Every example is one folder you can copy (plus `lib.ts`): the files a README names
are the terminals you open, and `node check.ts` proves the example. No build, no flags — Node 22.18+
or 23.6+ runs the `.ts` files as they are, after one `npm install` at the repo root (fero's one
dependency).

| # | Example | The one lesson | Terminals |
|---|---|---|---|
| 01 | [two-servers](01-two-servers/) | one file, run twice, is one replicated object; Ctrl-C one and the other carries on | `node server.ts` ×2 |
| 02 | [server-client](02-server-client/) | a seed makes a server; a bare `fero(name)` finds it by name, follows it, and writes back | `node server.ts` · `node client.ts` |

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
