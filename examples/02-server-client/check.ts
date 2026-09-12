//! ── 02 · the proof: a client started FIRST waits, then finds the server when it appears; rows flow down, sales flow up ──
//
//   node check.ts        (the smoke test in tests/examples.test.ts runs exactly this, under a private directory port)

import assert from 'node:assert'
import path from 'node:path'
import { privateDirectory, sleep, spawnRole, story, until, type Role } from '../lib.ts'

const dir = import.meta.dirname
const HEAD = 'fero two-terminal demo — '                               //! every render starts with this line: the frame separator (console.clear is a no-op on a pipe)
const roles: Role[] = []
const frames = (r: Role) => r.out.split(HEAD).slice(1)
const header = (r: Role) => frames(r).pop()?.split('\n')[0] ?? ''      //! the last screen's label line
const lastFrame = (r: Role) => { const f = frames(r).pop() ?? ''; const i = f.indexOf('{'); return i < 0 ? {} : JSON.parse(f.slice(i)) as Record<string, any> }
const listen = (r: Role) => /SERVER on (127\.0\.0\.1:\d+)/.exec(r.out)?.[1]
const sales = (r: Role) => Object.keys(lastFrame(r)).filter((k) => k.startsWith('sale-')).length

await privateDirectory()                                              //! a check meets its own directory, never the box's
await story(roles, async () => {
  //! the client FIRST: no server, so nobody hosts the directory — it renders an empty object with the directory
  // (down) and WAITS. The first (down) frame alone proves nothing (every client boots before its directory link
  // is up); the line STAYING (down) with no rows for a while is what proves there was nothing to dial.
  const client = spawnRole(path.join(dir, 'client.ts'), [], { tag: 'client', env: { FERO_EXAMPLE_TICKS: '2' } }); roles.push(client)
  assert.ok(await until(() => header(client).includes('(down)')), 'a bare client starts with the directory down')
  await sleep(1500)
  assert.ok(header(client).endsWith('(down) — servers []') && lastFrame(client).widgets === undefined, 'and stays that way: no directory, no servers, no rows — it waits')
  //! the server: a seed makes it a server; it hosts the directory and registers — the client finds it by name
  const server = spawnRole(path.join(dir, 'server.ts'), [], { tag: 'server', env: { FERO_EXAMPLE_TICKS: '12' } }); roles.push(server)
  assert.ok(await until(() => lastFrame(client).widgets?.stock !== undefined, 15_000), 'the client found the server through the directory and holds its rows')
  assert.ok(await until(() => listen(server) !== undefined && header(client).endsWith(`servers ["${listen(server)}"]`)), "the client's label names the server's port")
  assert.ok(await until(() => /watchers 1,/.test(server.out)), 'the server sees one watcher')
  //! sales: fact rows, relayed up and stamped at the server. The SERVER's count is the proof of the relay; the
  // watcher's own screen shows a sale the instant it is assigned (its optimistic copy), echo or no echo.
  assert.ok(await until(() => /sales 2\)/.test(server.out), 20_000), 'two sale rows reached the server')
  assert.ok(await until(() => sales(client) === 2), 'the watcher shows its own two sale rows')
  assert.ok(await until(() => { const g = lastFrame(server).gadgets; return g?.stock === 3 && g?.price === 19.99 }), 'the seeded gadgets row is untouched: a sale is a new row, not a rewrite')
  assert.equal(await client.exited, 0, 'the client stopped by itself after two sales')
  assert.equal(await server.exited, 0, 'the server stopped by itself after its ticks')
})
console.log('ok 02-server-client')
