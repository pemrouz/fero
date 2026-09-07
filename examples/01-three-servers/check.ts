//! ── 01 · the proof: three copies form a view; kill one, the rest keep going; a new copy joins and catches up ──
//
//   node check.ts        (the smoke test in tests/examples.test.ts runs exactly this, under a private directory port)

import assert from 'node:assert'
import path from 'node:path'
import { spawnRole, story, until, type Role } from '../lib.ts'

const SERVER = path.join(import.meta.dirname, 'server.ts')
const roles: Role[] = []
const uuid = (r: Role) => /I am (\w+)/.exec(r.out)?.[1]
const lastRow = (r: Role) => JSON.parse(r.out.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}') as Record<string, { ticks: number }>
const tickOf = (r: Role, id: string | undefined) => (id && lastRow(r)[id]?.ticks) ?? -1

await story(roles, async () => {
  const [a, b, c] = ['A', 'B', 'C'].map((tag) => { const r = spawnRole(SERVER, [], { tag }); roles.push(r); return r })
  //! three copies find each other through the directory and commit a three-member view
  assert.ok(await until(() => [a, b, c].every((r) => r.out.includes('members 3')), 30_000), 'three copies formed a view')
  assert.ok(await until(() => tickOf(a, uuid(c)) >= 1 && tickOf(c, uuid(a)) >= 1), 'rows replicate both ways')
  //! kill one: a CRASH, no destroy — the other two are still a majority, so writes keep committing
  b.kill('SIGKILL')
  const tA = tickOf(a, uuid(a))
  assert.ok(await until(() => tickOf(c, uuid(a)) >= tA + 2, 15_000), "A's writes still reach C with B dead")
  assert.ok(!a.out.includes('writable false'), 'the write gate never closed on A')
  //! start the file again: a NEW copy (new uuid) joins the survivors and catches up on everything
  const d = spawnRole(SERVER, [], { tag: 'D' }); roles.push(d)
  assert.ok(await until(() => tickOf(a, uuid(d)) >= 2 && tickOf(c, uuid(d)) >= 2, 30_000), "D's row shows on A and C")
  assert.ok(await until(() => tickOf(d, uuid(a)) >= tickOf(a, uuid(a)) - 1, 15_000), "A's latest ticks reached D")
  //! Ctrl-C everyone (SIGTERM → onExit → destroy): every copy stops cleanly
  for (const r of [a, c, d]) r.kill('SIGTERM')
  for (const [tag, r] of [['A', a], ['C', c], ['D', d]] as const) assert.equal(await r.exited, 0, `${tag} stopped cleanly`)
})
console.log('ok 01-three-servers')
