//! Tier-1 journal suite: bounded drop-oldest ring, monotone cursor reads, surfaced drop counter.

import { test } from 'node:test'
import assert from 'node:assert'
import { Journal, JK } from './journal.ts'

test('ring retains the newest cap events; overflow surfaces in .dropped, never silently', () => {
  const j = new Journal(4)
  for (let i = 0; i < 10; i++) j.emit(JK.writeLocal, i)
  assert.equal(j.n, 10)
  assert.equal(j.dropped, 6)
  const rows = j.read()
  assert.deepEqual(rows.map((r) => r.a), [6, 7, 8, 9])
  assert.deepEqual(rows.map((r) => r.t), [6, 7, 8, 9]) // t is the global monotone counter, not a ring slot
})

test('read(from) is a cursor: consumers resume where they left off, clamped to retention', () => {
  const j = new Journal(8)
  for (let i = 0; i < 5; i++) j.emit(JK.ping, i)
  const first = j.read(0)
  assert.equal(first.length, 5)
  for (let i = 5; i < 7; i++) j.emit(JK.ping, i)
  assert.deepEqual(j.read(5).map((r) => r.a), [5, 6])
  assert.deepEqual(j.read(100), []) // a future cursor reads nothing, not garbage
})

//! V4-NN: the refusal rows are kept beside the ring until a reader takes them — a burst past the cap inside one step
// overwrites the row in the ring, never in the kept list; emit() leaves the list alone; a list nobody takes stays bounded
test('keep() is emit() plus the same row kept beside the ring: it outlives a burst past the cap, emit() never adds to it, and it holds at most KEPT_MAX', async () => {
  const { KEPT_MAX } = await import('./journal.ts')
  const j = new Journal(1)
  j.keep(JK.doorReject, 7, 'uuid-taken', 'bb')
  const row = j.read()[0]
  for (let i = 0; i < 10; i++) j.emit(JK.identified, i)
  assert.equal(j.n, 11)
  assert.equal(j.read().some((e) => e.kind === JK.doorReject), false, 'the ring lost it')
  assert.deepEqual(j.kept, [row], 'the kept list did not: the very row the ring held')
  assert.deepEqual([row.kind, row.a, row.b, row.c, row.t], [JK.doorReject, 7, 'uuid-taken', 'bb', 0])
  j.kept.length = 0
  j.emit(JK.contractReject, 1, 'k', 'v')
  assert.deepEqual(j.kept, [], 'emit() keeps nothing')
  for (let i = 0; i < KEPT_MAX + 5; i++) j.keep(JK.contractReject, i, 'k', 'v')
  assert.equal(j.kept.length, KEPT_MAX)
  assert.deepEqual([j.kept[0].a, j.kept[KEPT_MAX - 1].a], [5, KEPT_MAX + 4], 'oldest out')
})

//! the guard on the composer's side of V4-NN: the refusal lines read the kept rows only, so a doorReject or a
// contractReject written with emit() would never print. Every one in the kernel goes through keep().
test('every door and contract refusal row in the kernel is written through keep(), the one source of the refusal lines', async () => {
  const fs = await import('node:fs')
  const dir = new URL('./', import.meta.url)
  const bad: string[] = []
  let kept = 0
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.perf.ts')) continue
    for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/\.(emit|keep)\(\s*JK\.(doorReject|contractReject)\b/g))
      if (m[1] === 'emit') bad.push(`${f}: ${m[0]}`); else kept++
  }
  assert.deepEqual(bad, [], 'written with emit(): its refusal line would never print')
  assert.ok(kept >= 8, `the refusal sites are found (${kept})`)
})
