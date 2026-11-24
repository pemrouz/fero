# fero v5

**Being built. Nothing runs yet.** fero v4, the current release, is on [`main`](https://github.com/pemrouz/fero/tree/main).

fero is distributed, replicated, reactive data for apps. You name a resource, and every server and client that opens it sees the same rows, kept in step as they change. v5 is a rewrite. Its core is in Rust: the disk, the log, agreement between servers, the links between them, and sending changes out. Above that line the rows live in [`data`](https://github.com/pemrouz/data), in JavaScript, and the app talks to fero through a TypeScript surface.

## Where things are

- **This branch** holds only v5's spec and code. The spec comes first: one page for the whole system, a ledger with every rule as one sentence, and the shapes in bytes.
- **The design record** is on the [`design`](https://github.com/pemrouz/fero/tree/design) branch: every decision and why ([DECISIONS.md](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md), V5-1 to V5-24), the study pages and the experiments behind them, the last review before building ([READY.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/READY.md)) and the build plan ([BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md)).
- **What happens now** is in [STATUS.md](STATUS.md).
