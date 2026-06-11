// resource/membership.ts — the view-change consensus core, driven DETERMINISTICALLY
// through a mock mesh (no sockets). handshake.test.ts does this for INIT/SYNC/DONE;
// this does it for the Paxos-flavoured ballot: joint-consensus quorum, the
// soft-coordinator, the write-gate, and — the headline — split-brain-heal
// reconciliation (#1) and missed-VIEW_COMMIT recovery (#2) via the re-announce.
//
// The mock: N ViewManagers share a router that delivers view frames ONLY across a
// `linked` pair (a partition just drops them), and each node's cluster.peers proxy
// reflects the same reachability. Short real timers + until() (the repo's e2e style)
// — the determinism is in the topology control, not the clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { $, value as VALUE } from '../../data/index.ts'
import { STATUS } from '../transport/peer.ts'
import { ViewManager } from './membership.ts'
import { until } from '#utils'

//! A mesh-shaped mock for one node: view-frame senders route to the peer's handler IFF the link is up; installView records the ring.
type Net = {
  reach: (a: string, b: string) => boolean // is the a→b link up right now?
  vm: (addr: string) => ViewManager | undefined
  installed: Map<string, string[]> // addr → last installed ring (for assertions)
}

const harness = (addrs: string[]) => {
  const vms = new Map<string, ViewManager>()
  const peersOf = new Map<string, any>()
  const installed = new Map<string, string[]>()
  // partition state: group id per address; same group ⇒ linked
  let group = new Map<string, number>(addrs.map((a) => [a, 0]))
  const reach = (a: string, b: string) => group.get(a) === group.get(b)

  const net: Net = { reach, vm: (a) => vms.get(a), installed }

  // rebuild every node's cluster.peers to reflect current reachability
  const syncPeers = () => {
    for (const me of addrs) {
      const peers = peersOf.get(me)
      for (const other of addrs) {
        if (other === me) continue
        if (group.get(me) === group.get(other)) peers[other] = { address: other, role: 'server', status: STATUS.connected, suspect: false }
        else if (peers[VALUE]?.[other]) delete peers[other]
      }
    }
  }

  const mesh = (me: string) => ({
    installView: (members: string[]) => installed.set(me, members.slice()),
    viewPrepare: (to: string, v: unknown) => { if (reach(me, to)) { vms.get(to)?.onPrepare(v); return true } return false },
    viewAck: (to: string, v: unknown) => { if (reach(me, to)) { vms.get(to)?.onAck(v); return true } return false },
    viewCommit: (to: string, v: unknown) => { if (reach(me, to)) { vms.get(to)?.onCommit(v); return true } return false },
  })

  for (const me of addrs) {
    const peers = $({})
    peersOf.set(me, peers)
    vms.set(
      me,
      new ViewManager({
        me,
        mesh: mesh(me) as any,
        peers,
        interval: 15,
        ackTimeout: 70,
        announce: 50,
        evictAfter: 100000, // eviction off — these tests exercise reconcile, not eviction
      }),
    )
  }
  syncPeers()

  return {
    net,
    vm: (a: string) => vms.get(a)!,
    installed,
    // move `members` into their own partition group (a fresh id) — drops links to everyone else
    partition: (...members: string[]) => {
      const g = Math.max(0, ...group.values()) + 1
      for (const m of members) group.set(m, g)
      syncPeers()
    },
    // re-merge everyone into one group
    heal: () => { group = new Map(addrs.map((a) => [a, 0])); syncPeers() },
    destroy: () => { for (const vm of vms.values()) vm.destroy() },
  }
}

const epochsAgree = (h: ReturnType<typeof harness>, addrs: string[]) => {
  const es = addrs.map((a) => h.vm(a).epoch)
  const ms = addrs.map((a) => h.vm(a).members.join(','))
  return es.every((e) => e === es[0]) && ms.every((m) => m === ms[0])
}

test('membership: N nodes converge on ONE committed view (coordinator = lowest address)', async () => {
  const addrs = ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1']
  const h = harness(addrs)
  try {
    assert.ok(await until(() => epochsAgree(h, addrs), 3000), 'all three converge on one view')
    const v = h.vm(addrs[0])
    assert.deepEqual(v.members, addrs.slice().sort(), 'the view is everyone')
    assert.ok(v.epoch >= 2, 'epoch advanced past the solo boot view')
    // the ring was installed to exactly the committed members on every node
    for (const a of addrs) assert.deepEqual(h.installed.get(a)!.slice().sort(), addrs.slice().sort())
  } finally {
    h.destroy()
  }
})

test('membership: a minority side is write-gated; the majority keeps quorum (CP)', async () => {
  const addrs = ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1', '10.0.0.4:1', '10.0.0.5:1']
  const h = harness(addrs)
  try {
    assert.ok(await until(() => epochsAgree(h, addrs), 4000), 'formed')
    h.partition('10.0.0.1:1', '10.0.0.2:1') // 2 vs 3
    // the 2-node minority loses quorum (majority of a 5-view is 3) → read-only
    assert.ok(await until(() => h.vm('10.0.0.1:1').canWrite === false, 3000), 'minority went read-only')
    // the 3-node majority keeps quorum
    assert.equal(h.vm('10.0.0.3:1').canWrite, true, 'majority stays writable')
  } finally {
    h.destroy()
  }
})

test('membership: split-brain HEALS — two committed views reconcile to one (the deadlock fix #1)', async () => {
  // {A,B,C,D,E} forms @≥2, then partitions {A,B}|{C,D,E}. With eviction OFF, the majority
  // {C,D,E} does NOT re-commit (no member-set delta on its side either) — so to force two
  // DISTINCT committed epochs we evict via a separate harness path: here we instead let the
  // majority re-form by toggling eviction on its side. Simpler + faithful: drive the documented
  // deadlock directly — give the two sides different committed views, heal, assert they merge.
  const addrs = ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1', '10.0.0.4:1', '10.0.0.5:1']
  const h = harness(addrs)
  try {
    assert.ok(await until(() => epochsAgree(h, addrs), 4000), 'formed as one view')
    const baseEpoch = h.vm(addrs[0]).epoch

    // Force the majority {C,D,E} to commit a NEW view excluding {A,B}: partition, and turn on
    // eviction for that side by directly committing a view there (simulating the eviction ballot
    // the majority would run). We drive it through the real ballot by partitioning then nudging
    // the majority coordinator to re-propose via a membership delta it CAN satisfy.
    h.partition('10.0.0.3:1', '10.0.0.4:1', '10.0.0.5:1') // {A,B} | {C,D,E}
    // inject the eviction outcome the majority would reach: C (its coordinator) commits {C,D,E}
    const cdeEpoch = baseEpoch + 5
    const cde = ['10.0.0.3:1', '10.0.0.4:1', '10.0.0.5:1']
    for (const m of cde) h.vm(m).onCommit({ epoch: cdeEpoch, members: cde })
    assert.ok(h.vm('10.0.0.3:1').members.length === 3, 'majority committed {C,D,E}')
    assert.equal(h.vm('10.0.0.1:1').members.length, 5, 'A still on the stale 5-node view (the split)')

    // HEAL — before the fix this DEADLOCKED: A (merged coordinator) saw no member-set delta
    // and never re-proposed; C/D/E went quiet seeing A's lower address. The re-announce surfaces
    // C's higher epoch to A, and A re-proposes a unifying view.
    h.heal()
    assert.ok(await until(() => epochsAgree(h, addrs), 6000), 'the cluster reconciled to ONE view after heal')
    const v = h.vm(addrs[0])
    assert.deepEqual(v.members, addrs.slice().sort(), 'the merged view re-admits A and B')
    assert.ok(v.epoch > cdeEpoch, 'at a fresh epoch above BOTH prior views')
  } finally {
    h.destroy()
  }
})

test('membership: a node that MISSED its VIEW_COMMIT recovers via the re-announce (#2)', async () => {
  const addrs = ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1']
  const h = harness(addrs)
  try {
    assert.ok(await until(() => epochsAgree(h, addrs), 3000), 'formed')
    const v = h.vm(addrs[0])
    const epoch = v.epoch
    const members = v.members.slice()

    // Simulate node C missing the commit for a NEW higher view: the coordinator committed
    // (epoch+3, members) but C never got the frame (its socket was momentarily un-writable).
    // A and B install it; C is stranded at the old epoch.
    const newEpoch = epoch + 3
    h.vm('10.0.0.1:1').onCommit({ epoch: newEpoch, members })
    h.vm('10.0.0.2:1').onCommit({ epoch: newEpoch, members })
    assert.equal(h.vm('10.0.0.3:1').epoch, epoch, 'C stranded at the old epoch (missed its commit)')

    // the re-announce from the view's lowest reachable member re-delivers it; C is a member → adopts
    assert.ok(await until(() => h.vm('10.0.0.3:1').epoch === newEpoch, 3000), 'C recovered the missed view via re-announce')
    assert.ok(epochsAgree(h, addrs), 'all three agree again')
  } finally {
    h.destroy()
  }
})

test('membership: a node hearing a higher view it is NOT in does not self-orphan (records the epoch only)', () => {
  const addrs = ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1']
  const h = harness(addrs)
  try {
    const a = h.vm('10.0.0.1:1')
    const before = a.members.slice()
    // a re-announce of a higher view that EXCLUDES A — A must not adopt it (it'd orphan itself);
    // its coordinator re-admits it via a merge. (Here we just assert no self-orphan.)
    a.onCommit({ epoch: 999, members: ['10.0.0.2:1', '10.0.0.3:1'] })
    assert.ok(a.members.includes('10.0.0.1:1'), 'A did not orphan itself out of the view')
    assert.deepEqual(a.members, before, 'A kept its own committed members')
  } finally {
    h.destroy()
  }
})
