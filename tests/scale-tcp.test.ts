//! Tier-3 SCALE smoke: 12 real nodes over real sockets through the PUBLIC surface — the dial-storm
// shape sim structurally cannot model (132 near-simultaneous real dials against 12 accept queues
// under the OS scheduler, real TCP chunking at mesh fan-in). NO chaos here: partition/heal stays
// sim-only by design (api-scenarios banner, DESIGN-M7 §5 decision 3), and anything found on real
// sockets must reproduce as a sim primitive before its fix merges. The protocol at n≥50 is
// Tier-2's job (sim/scale.test.ts); THIS file proves the shell composition survives fan-in 12 —
// 12 listeners + 132 sockets ≈ 144 fds, 7x under the default 1024 ulimit.

//! the directory is OFF in this suite regardless of how it is run: a single-file `node --test` must never
// meet a live box directory (the battery's npm script sets the same default)
process.env.FERO_RENDEZVOUS ??= 'off'

import { test } from 'node:test'
import assert from 'node:assert'
import { fero, type Fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { ports, until } from '#utils'

//! the api-scenarios vocabulary at n=12 (same shapes, higher fan-in; sequential ports.free() is the
// accepted TOCTOU class of this tier)
const spawn = async (n: number): Promise<Fero[]> => {
  const ps: number[] = []
  for (let i = 0; i < n; i++) ps.push(await ports.free())
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  return Promise.all(addrs.map((listen, i) =>
    fero('scale-smoke', {
      uuid: `n${String(i + 1).padStart(2, '0')}`,
      listen,
      hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: 50,
      redialMs: 30,
    })))
}
const canon = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
    : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : JSON.stringify(v)

test('SCALE-TCP 12-node dial storm: 132 real dials dedup to one view, every writer replicates, teardown is clean', async () => {
  const nodes = await spawn(12)
  try {
    assert.ok(
      await until(() => nodes.every((f) => (snapshot(f.cluster) as { epoch: number }).epoch >= 1), 15_000),
      'one committed 12-member view out of the dial storm',
    )
    const members = (snapshot(nodes[0].cluster) as { members: Record<string, string> }).members
    assert.equal(Object.keys(members).length, 12, 'all 12 admitted into the view')
    //! every node writes concurrently — the fan-in matrix: 12 origins × 11 receivers over real sockets
    nodes.forEach((f, i) => { f.data[`row${i}`] = { by: i, deep: { list: [i, `x${i}`] } } })
    nodes[0].data.shared = 'last'
    assert.ok(
      await until(() => {
        const first = canon(snapshot(nodes[0].data))
        return first !== '{}' && nodes.every((f) => canon(snapshot(f.data)) === first)
      }, 15_000),
      'all 12 snapshots identical — replication survived mesh fan-in',
    )
    const s = snapshot(nodes[0].data) as Record<string, unknown>
    for (let i = 0; i < 12; i++) assert.ok(s[`row${i}`], `row${i} present — no origin lane was lost in the storm`)
  } finally {
    for (const f of nodes) await f.destroy()
  }
})
