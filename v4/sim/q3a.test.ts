//! THE Q3A HUNT (M6 slice 5, plan §11 verbatim: "the v2 Q3a flake hunted deliberately under seed
// sweep (suspected real bug)"). VERDICT: REAL, REPRODUCED, CLOSED. v2's live gather claimed from
// OWNED-ONLY scope and recombined by root-replace — during an {A,B}→{C,D} handover both old holders
// retracted at descope while the new holders were still acquiring, the union zero-claimed the key,
// and subscribers watched it vanish. The mutation study (this suite's shape with a v2-faithful
// gather swapped in) reproduces the vanish on 60/60 seeds; v3's design answer — claims from held ∪
// UNSHED-ORPHAN scope, per-key stamped merge, PARKING (a key leaves only via a dominating tombstone
// or the coverage sweep) — survives the identical window on 0/60 (and the 0-999 ad-hoc sweep).
//
// Two legs, both driving the REAL Gather (api/fold.ts) over sim kernels (the fan-out call reads each
// member's rowsPartial in-process — claim TIMING is the hazard, not the wire):
//   ORGANIC — a live gather open across a single-join grow. Consistent-hash minimal motion keeps ≥1
//   old holder in every moved R-set, so this leg pins the common path.
//   H2-SHAPED — the {A,B}→{C,D} pin-flip: BOTH R-set slots replaced in one rescope (the only shape
//   that can zero-claim), refreshed on 5ms slices straight through the acquisition window.
// THE MONITOR: a top-level key present in the previous union and absent from the current one while
// ANY node's kernel state still holds it. NOTE the key-set COPY — snapshot() returns a live
// reference the next refresh mutates in place; comparing it to itself is how a monitor goes blind.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { Gather, rowsPartial } from '../api/fold.ts'
import { snapshot } from './../api/substrate.ts'
import { REC } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'
import type { Runtime } from '../shell/runtime.ts'

const gatherFor = (sim: Sim, coordinator: Node) =>
  new Gather({ node: coordinator } as unknown as Runtime, async (uuid) => {
    const n = sim.nodes.get(uuid)
    if (!n) throw new Error('down')
    return rowsPartial({ node: n } as unknown as Runtime)
  })

const keysOf = (g: Gather): Set<string> => new Set(Object.keys(snapshot(g.proxy) as Record<string, unknown>))
const heldAnywhere = (sim: Sim, top: string): boolean => {
  for (const [, n] of sim.nodes)
    for (const cell of n.state.keys()) if ((JSON.parse(cell) as string[])[0] === top) return true
  return false
}
//! THE ORACLE — an independent naive fold of what the union MUST show at this instant: every cell
// across every node's claim-eligible scope (held ∪ orphan), winner by the kernel's (epoch, seq,
// origin) order, a top-level key present iff some cell under it wins NON-tombstone. Raw state
// presence is NOT the oracle (the first hunt's false positive): a frozen orphan lawfully keeps a
// stale copy of a cell whose newest claim is a tombstone — the union rightly drops that key.
const oracle = (sim: Sim): Set<string> => {
  const win = new Map<string, { st: [number, number, string]; dead: boolean }>()
  for (const [, n] of sim.nodes) {
    if (!n.scope) continue
    for (const [cell, v] of n.versions) {
      const p = (JSON.parse(cell) as string[])[0] ?? ''
      const e = n.scope.entries.get(p)
      if (!e || e.state === 2) continue // acquiring attests nothing
      const st: [number, number, string] = [v.epoch, v.seq, v.origin]
      const cur = win.get(cell)
      const newer = !cur || st[0] !== cur.st[0] ? !cur || st[0] > cur.st[0] : st[1] !== cur.st[1] ? st[1] > cur.st[1] : st[2] > cur.st[2]
      //! explicit-undefined = tombstone-equivalent, matching rowsPartial (the value-codec ticket)
      if (newer) win.set(cell, { st, dead: !n.state.has(cell) || n.state.get(cell) === undefined })
    }
  }
  const out = new Set<string>()
  for (const [cell, w] of win) if (!w.dead) out.add((JSON.parse(cell) as string[])[0] ?? '')
  return out
}

test('Q3A organic — 40 seeds of single-join grow with a live gather open: the union never blinks a held key', async () => {
  //! engagement ledger (M6-review finding 34): silently-skipped unformed seeds must not inflate
  // the sweep's claim — the formed count is asserted at the end.
  let formedSeeds = 0
  for (let seed = 0; seed < 40; seed++) {
    const sim = new Sim(seed)
    const members = cluster(sim, 2, { heartbeatMs: 50, replicas: 2 })
    sim.run({ until: 1200 })
    if (!formed(members)) continue
    formedSeeds++
    const gather = gatherFor(sim, members[0])
    writes(sim, members, 12, 250)
    sim.at(400 + Math.floor(sim.rng() * 300), () => {
      sim.add({
        uuid: 'n99', listen: 'sim:n99', hosts: members.map((m) => `sim:${m.uuid}`),
        heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, replicas: 2,
      })
      sim.post('n99', { kind: 'start' }, 0)
    })
    for (let i = 0; i < 8; i++)
      sim.post(members[i % 2].uuid, { kind: 'write', recs: [{ type: REC.update, key: [`g${i % 4}`, 'v'], value: `s${seed}-${i}` }] }, 500 + sim.rng() * 900)
    let last = new Set<string>()
    for (let t = 0; t <= 9000; t += 25) {
      sim.run({ until: 1200 + t })
      await gather.refresh({ node: members[0] } as unknown as Runtime, { throwOnPartial: false }).catch(() => {})
      const cur = keysOf(gather)
      //! per-instant containment: everything the oracle says exists MUST be in the union (the
      // refresh and the oracle read the same consistent cut — the sim does not advance in between)
      for (const k of oracle(sim))
        assert.ok(cur.has(k), `seed ${seed} @t+${t}: '${k}' VANISHED from the live union while its LWW fold still holds it`)
      last = cur
    }
    assert.ok(last.size >= 4, `seed ${seed}: the union saw the workload (${last.size} cells)`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: kernel monitors green under the hunt`)
    gather.destroy()
  }
  assert.ok(formedSeeds >= 30, `the sweep actually ran: ${formedSeeds}/40 seeds formed (a silent skip is not a pass)`)
})

test('Q3A H2-shaped — 60 seeds of {A,B}→{C,D} pin-flips under delay faults, 5ms slices: the PARKED union survives the window that broke v2 on 60/60', async () => {
  let formedSeeds = 0
  for (let seed = 0; seed < 60; seed++) {
    const sim = new Sim(seed)
    const members = cluster(sim, 4, { heartbeatMs: 50, replicas: 2, fault: { delay: [5, 60] } })
    sim.run({ until: 2000 })
    if (!formed(members)) continue
    formedSeeds++
    for (const m of members) m.writes.ring.place('gx', 'n01', 'n02')
    sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['gx', 'v'], value: `s${seed}` }] }, 0)
    sim.run({ until: 2400 })
    const gather = gatherFor(sim, members[2])
    await gather.refresh({ node: members[2] } as unknown as Runtime, { throwOnPartial: false })
    assert.ok(keysOf(gather).has('gx'), `seed ${seed}: the pre-flip union claims gx`)
    //! THE FLIP: both R-set slots replace at once — the only shape that can zero-claim — and the
    // rescope runs the REAL protocol (freeze → announce → latch → teach → fold → shed)
    for (const m of members) m.writes.ring.place('gx', 'n03', 'n04')
    for (const m of members) m.scope!.rescope(m)
    for (let t = 0; t <= 3000; t += 5) {
      sim.run({ until: 2400 + t })
      await gather.refresh({ node: members[2] } as unknown as Runtime, { throwOnPartial: false }).catch(() => {})
      //! gx is never removed in this leg: it must stay in the union through the ENTIRE double handover
      if (heldAnywhere(sim, 'gx'))
        assert.ok(keysOf(gather).has('gx'), `seed ${seed} @t+${t}: gx VANISHED mid-handover — the v2 Q3a bug is back`)
    }
    //! and the lifecycle completed underneath: the new holders hold, the old holders shed
    assert.ok(members[2].scope!.held('gx') && members[3].scope!.held('gx'), `seed ${seed}: the new R-set holds gx`)
    assert.ok(!members[0].scope!.entries.has('gx') && !members[1].scope!.entries.has('gx'), `seed ${seed}: the old holders drained`)
    assert.equal(members[2].state.get(JSON.stringify(['gx', 'v'])), `s${seed}`, `seed ${seed}: the value survived the double handover`)
    //! the kernel monitors ran through the whole window (finding 34: this leg never checked them —
    // a kernel invariant break under the pin-flip would have passed silently)
    assert.deepEqual(sim.violations, [], `seed ${seed}: kernel monitors green through the pin-flip`)
    gather.destroy()
  }
  assert.ok(formedSeeds >= 45, `the H2 sweep actually ran: ${formedSeeds}/60 seeds formed`)
})
