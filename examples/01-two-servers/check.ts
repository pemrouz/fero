//! ── 01 · the proof: two copies form a view; stop one, the other carries on alone; a new copy joins and catches up ──
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
const lastView = (r: Role) => r.out.trim().split('\n').filter((l) => l.startsWith('members ')).pop() ?? ''

await story(roles, async () => {
  const [a, b] = ['A', 'B'].map((tag) => { const r = spawnRole(SERVER, [], { tag }); roles.push(r); return r })
  //! two copies find each other through the directory and commit a two-member view
  assert.ok(await until(() => [a, b].every((r) => r.out.includes('members 2')), 30_000), 'two copies formed a view')
  assert.ok(await until(() => tickOf(a, uuid(b)) >= 1 && tickOf(b, uuid(a)) >= 1), 'rows replicate both ways')
  //! Ctrl-C one (SIGTERM → onExit → destroy): a clean stop LEAVES — the view shrinks by a ballot, at once,
  // and the survivor is writable alone. A crash (SIGKILL) here would wedge it instead: two cannot lose one.
  b.kill('SIGTERM')
  assert.equal(await b.exited, 0, 'B stopped cleanly')
  assert.ok(await until(() => lastView(a).startsWith('members 1 writable true'), 5000), 'the survivor shrank the view and stayed writable')
  const tA = tickOf(a, uuid(a))
  assert.ok(await until(() => tickOf(a, uuid(a)) >= tA + 2, 5000), 'A keeps committing alone')
  assert.ok(!a.out.includes('writable false'), 'the write gate never closed on A')
  //! start the file again: a NEW copy (new uuid) is voted in and catches up on everything — B's row included
  const c = spawnRole(SERVER, [], { tag: 'C' }); roles.push(c)
  assert.ok(await until(() => lastView(a).startsWith('members 2 writable true') && tickOf(a, uuid(c)) >= 2, 30_000), "C was voted in and its row shows on A")
  assert.ok(await until(() => tickOf(c, uuid(a)) >= tickOf(a, uuid(a)) - 1 && tickOf(c, uuid(b)) === tickOf(a, uuid(b)), 15_000), "A's latest ticks and B's old row reached C")
  //! Ctrl-C everyone: every copy stops cleanly
  for (const r of [a, c]) r.kill('SIGTERM')
  for (const [tag, r] of [['A', a], ['C', c]] as const) assert.equal(await r.exited, 0, `${tag} stopped cleanly`)
})
console.log('ok 01-two-servers')
