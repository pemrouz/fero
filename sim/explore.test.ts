//! The random explorer over REAL kernel Nodes (sim/mesh.ts), pinned: 2000 seeded schedules of clean stops, cuts,
// heals, give-ups, teardowns, restarts from the boot record and a join, with every frame delivery chosen by the
// seed. One claim, asserted on every seed: ONE VIEW PER EPOCH across every life of every node (a second members
// key installed at an epoch anywhere is a split). Liveness is not claimed.
// This is the breadth guard for the proposer-side double vote fixed on 2026-10-08 (kernel/membership.ts #nextEpoch:
// a fresh ballot of mine never opens below my own last ballot). On the kernel before the fix, seeds 947 and 1855 of
// this range split: 'epoch 3: {cc,dd,ee} vs {aa,dd,ee}' and 'epoch 3: {aa,cc,dd,ee,ff} vs {aa,dd,ee}' (measured
// 2026-10-08: 2 splits in 2000 seeds before, 0 in 40,000 after). The leave sweep (sim/leave-sweep.test.ts) cannot
// draw that shape; the two kernel pins in kernel/membership.test.ts draw it by hand; this file draws it by chance.
// Bounded: about 7 s at low priority on the idle WSL2 box (the whole range runs in one node; a seed stops at its
// first split). The reach floors below say the range still has teeth: the schedules install thousands of views,
// restart thousands of nodes, and climb well past epoch 1.

import { test } from 'node:test'
import assert from 'node:assert'
import { explore } from './mesh.ts'

test('explorer: 2000 seeded random schedules over real Nodes — leaves, cuts, heals, restarts from disk, a join — never two views at one epoch (before the #nextEpoch fix: seeds 947 and 1855 split)', () => {
  const bad: string[] = []
  let installs = 0, restarts = 0, maxEpoch = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const x = explore(seed)
    installs += x.installs; restarts += x.restarts; maxEpoch = Math.max(maxEpoch, x.maxEpoch)
    if (x.threw) bad.push(`seed ${seed} n=${x.n} THREW ${x.threw} :: ${x.trace.slice(-5).join('; ')}`)
    else if (x.splits.length) bad.push(`seed ${seed} n=${x.n}: ${x.splits[0]} | ${x.trace.slice(-40).join('; ')}`)
  }
  assert.deepEqual(bad, [], 'a split (two views at one epoch), or a node threw')
  //! reach: measured 14,687 installs, 7,295 restarts and epoch 10 on 2026-10-08; the floors are a third of that
  assert.ok(installs >= 5000 && restarts >= 2000 && maxEpoch >= 6, `the range lost its teeth: installs ${installs} restarts ${restarts} maxEpoch ${maxEpoch}`)
})
