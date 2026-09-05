//! ── the two-terminal demo (plan §11 M5): one resource, two processes, real sockets ──
//
//   terminal 1:  npm run demo -- serve     → examples/server.ts
//   terminal 2:  npm run demo -- watch     → examples/client.ts
//
// V4-3: zero addresses, zero identities, zero internals imports — and zero hashing. The server is a
// server because it DECLARES an initial value (`data:` is a server marker — role by declared act);
// it binds a free loopback port and registers it with the box's directory (the `#directory` system
// resource at the rendezvous address, hosted by the first server on the box). The watcher is bare
// fero(name) — a client by default — and looks the name up live. The watcher WRITES too: a sale
// every four seconds by plain assignment, relayed to the server, stamped there, echoed back to
// every watcher. Kill the server mid-run and restart it with the same command: it gets a NEW port,
// the directory says so, the watcher redials, catches up over anti-entropy, and the tap resumes.
// Run a second `serve` in a third terminal: the two servers find each other the same way and form
// a cluster. Everything in the two files is the public surface — `fero`, `data`, `cluster.me`, taps.

const mode = process.argv[2]

if (mode === 'serve') await import('./server.ts')
else if (mode === 'watch') await import('./client.ts')
else {
  console.log('usage: npm run demo -- serve | watch')
  process.exit(1)
}
