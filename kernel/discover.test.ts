//! Tier-1/2 discover suite (V4-3): the `discover` event — the dynamic host set the directory feeds the
// kernel — against the recording sink (dial / cover / park / re-add / static-and-member-never-parked /
// the name-reject revival), and genesis over a DISCOVERED set in the sim (a mesh whose static hosts are
// all empty forms only through discover; a late registrant joins at the next epoch through the ordinary
// JOIN path). The park pins are the V4-3 panel's: a park CANCELS the armed redial timer (no orphaned
// second chain on re-add), an in-flight dial is visible to a park, and a forgotten target that nothing
// names any more leaves #backoff instead of living there forever.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node, MAX_REDIALS } from './node.ts'
import { VERB, encodeControl } from './codec.ts'
import { TAG, type EffectSink, type Env } from './env.ts'
import { Sim } from '../sim/exec.ts'
import { formed } from '../sim/harness.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (rec) => effects.push(['apply', rec]),
    persist: (batch, bytes) => effects.push(['persist', batch, bytes]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, redialMs: 10, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const connects = () => of('connect').map((e) => e[1] as string)
  const redials = () => of('timer').filter((e) => e[2] === TAG.redial)
  const fire = (t: unknown[]) => node.step({ kind: 'timer', id: t[1] as number, tag: t[2] as number })
  const heartbeat = () => fire(of('timer').find((e) => e[2] === TAG.heartbeat)!)
  return { node, effects, of, connects, redials, fire, heartbeat }
}
const hello = (u: string, l = `sim:${u}`, name?: string) => encodeControl(VERB.HELLO, { u, i: 1, l, ...(name !== undefined ? { n: name } : {}) })

test('discover: added targets dial (own listen excluded), node.hosts is static ∪ dynamic, and the cache re-derives on change', () => {
  const { node, connects } = harness('aa', { hosts: ['sim:st'] })
  node.step({ kind: 'start' })
  assert.deepEqual(connects(), ['sim:st'])
  node.step({ kind: 'discover', hosts: ['sim:bb', 'sim:aa', 'sim:cc', 'sim:bb'] })
  assert.deepEqual(connects().slice(1), ['sim:bb', 'sim:cc'], 'new targets dial once each; own listen and duplicates are dropped')
  assert.deepEqual(node.hosts, ['sim:st', 'sim:bb', 'sim:cc'])
  const cached = node.hosts
  assert.equal(node.hosts, cached, 'the per-tick readers get the cached array, not a fresh allocation')
  assert.ok(node.dialing('sim:bb'), 'a dial in flight is visible (a park arriving now must see it)')
  node.step({ kind: 'discover', hosts: ['sim:bb'] })
  assert.deepEqual(node.hosts, ['sim:st', 'sim:bb'], 'replaced wholesale')
  //! a listen assignment (the shell's port-0 publish) invalidates the cache: own listen leaves the set
  node.listen = 'sim:bb'
  assert.deepEqual(node.hosts, ['sim:st'])
})

test('discover: a target a live link already covers is not re-dialed — our dialed `to` (pre-HELLO too) OR the gossiped listen', () => {
  const { node, connects } = harness('aa')
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'linkUp', link: 2, dialed: false }) // cc dialed US — covered by its gossiped listen
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('cc') })
  node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:ee' }) // a dialed link still waiting for its HELLO
  node.step({ kind: 'discover', hosts: ['sim:bb', 'sim:cc', 'sim:dd', 'sim:ee'] })
  assert.deepEqual(connects(), ['sim:dd'], 'only the uncovered target dials — the pre-HELLO dialed link covers ee by `to`')
  assert.deepEqual(node.hosts, ['sim:bb', 'sim:cc', 'sim:dd', 'sim:ee'], 'covered targets still count as hosts (genesis quorum)')
})

test('discover: a forgotten target CANCELS its armed redial timer, parks only while a dial/link still names it, and re-adds as ONE fresh chain', () => {
  const { node, connects, redials, of, fire } = harness('aa', { heartbeatMs: 100 })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:cc'] })
  assert.deepEqual(connects(), ['sim:cc'])
  node.step({ kind: 'linkDown', link: 7, reason: 'refused', to: 'sim:cc' }) // a failed dial → the chain arms
  assert.equal(redials().length, 1)
  assert.ok(node.dialing('sim:cc'), 'an active chain reports dialing (eviction hold)')
  const armed = redials()[0]
  node.step({ kind: 'discover', hosts: [] })
  assert.deepEqual(node.hosts, [])
  assert.equal(node.dialing('sim:cc'), false, 'parked: no longer "actively trying"')
  assert.deepEqual(of('cancel').map((e) => e[1]), [armed[1]], 'the armed redial timer was CANCELLED — no orphaned chain')
  fire(armed) // a stale fire of the cancelled id is ignored by the kernel
  assert.equal(connects().length, 1, 'the cancelled timer dials nothing')
  //! the heartbeat's give-up revival never lists a forgotten target
  const hb = of('timer').find((e) => e[2] === TAG.heartbeat)!
  fire(hb)
  assert.equal(connects().length, 1, 'not revived')
  //! re-add: exactly one fresh chain — and its failure arms exactly one timer
  node.step({ kind: 'discover', hosts: ['sim:cc'] })
  assert.deepEqual(connects(), ['sim:cc', 'sim:cc'])
  node.step({ kind: 'linkDown', link: 8, reason: 'refused', to: 'sim:cc' })
  assert.equal(redials().length, 2, 'one new timer for the re-added chain (the panel\'s doubled-chain fork is closed)')
  assert.ok(node.dialing('sim:cc'))
  //! an IN-FLIGHT dial parks (the entry stays so its failure ends the chain) — then the entry LEAVES
  fire(redials()[1]) // the chain dials again — in flight, no link yet
  node.step({ kind: 'discover', hosts: [] })
  assert.equal(node.dialing('sim:cc'), false)
  node.step({ kind: 'linkDown', link: 9, reason: 'refused', to: 'sim:cc' }) // the in-flight dial fails
  assert.equal(redials().length, 2, 'a parked target\'s failure arms NO timer — the chain ended')
  node.step({ kind: 'discover', hosts: [] }) // nothing names it now — the entry is gone, not parked forever
  node.step({ kind: 'linkDown', link: 10, reason: 'refused', to: 'sim:cc' }) // a stray late failure: fresh chain would be a leak signal
  assert.equal(redials().length, 3, 'with no park left, a stray failure starts an ordinary bounded chain (the entry did not linger)')
})

test('discover: a STATIC host mid-chain is never parked by a discover that omits it — the chain and revival continue', () => {
  const { node, connects, redials, of, fire } = harness('aa', { hosts: ['sim:st'], heartbeatMs: 100 })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:st'] })
  assert.equal(connects().length, 1, 'a static host is already dialing — not re-dialed')
  node.step({ kind: 'linkDown', link: 1, reason: 'refused', to: 'sim:st' })
  assert.equal(redials().length, 1)
  node.step({ kind: 'discover', hosts: [] }) // omits the static host, mid-chain
  assert.deepEqual(node.hosts, ['sim:st'], 'static hosts survive every discover')
  assert.ok(node.dialing('sim:st'), 'NOT parked: the chain still owns it')
  assert.equal(of('cancel').length, 0, 'its timer was not cancelled')
  fire(redials()[0])
  assert.equal(connects().length, 2, 'the chain dialed again')
  for (let i = 0; i < MAX_REDIALS + 1; i++) {
    node.step({ kind: 'linkDown', link: 100 + i, reason: 'refused', to: 'sim:st' })
    const t = redials().at(-1)!
    if (node.dialing('sim:st')) fire(t)
  }
  const before = connects().length
  fire(of('timer').find((e) => e[2] === TAG.heartbeat)!)
  assert.equal(connects().length, before + 1, 'give-up revival still dials the static host')
})

test('discover: a COMMITTED MEMBER is never parked by a discover that omits it (the view names it)', () => {
  const { node, connects, redials, of } = harness('aa', { heartbeatMs: 100, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:bb'] })
  assert.deepEqual(connects(), ['sim:bb'])
  node.step({ kind: 'linkDown', link: 1, reason: 'refused', to: 'sim:bb' })
  assert.equal(redials().length, 1)
  node.step({ kind: 'discover', hosts: [] })
  assert.ok(node.dialing('sim:bb'), 'a member mid-chain keeps its chain (eviction hold intact)')
  assert.equal(of('cancel').length, 0)
  assert.deepEqual(node.hosts, [], 'not a host any more — but revival ranges over hosts ∪ VIEW')
})

test('name-reject on a DIALED target parks it given-up: no redial chain, but the heartbeat revives it — a squatter or a late-arriving resource heals at heartbeat cadence', () => {
  const { node, connects, redials, of, heartbeat } = harness('aa', { name: 'r', hosts: ['sim:rz'], heartbeatMs: 100 })
  node.step({ kind: 'start' })
  assert.deepEqual(connects(), ['sim:rz'])
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:rz' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('zz', 'sim:rz', 'other') })
  assert.deepEqual(of('close').at(-1), ['close', 1, 'name-mismatch'])
  node.step({ kind: 'linkDown', link: 1, reason: 'name-mismatch' })
  assert.equal(redials().length, 0, 'never a redial chain against a misconfigured port')
  assert.equal(node.dialing('sim:rz'), false, 'no eviction hold either')
  heartbeat()
  assert.deepEqual(connects(), ['sim:rz', 'sim:rz'], 'revived once per heartbeat — the strand the V4-3 panel found is closed')
  node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:rz' })
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('zz', 'sim:rz', 'r') }) // the right resource answers now
  assert.deepEqual(node.admitted(), ['zz'], 'heals the moment the right resource is there')
})

test('sim: genesis over a DISCOVERED set — empty static hosts never form; discover forms view 1; a late registrant joins at epoch 2', () => {
  const sim = new Sim(7)
  const ids = ['n01', 'n02', 'n03']
  const nodes = ids.map((id) => sim.add({ uuid: id, listen: `sim:${id}`, hosts: [], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 }))
  for (const id of ids) sim.post(id, { kind: 'start' })
  sim.run({ until: 400 })
  assert.deepEqual(nodes.map((n) => n.epoch), [0, 0, 0], 'nothing to dial, nothing forms')
  //! the directory speaks: every node learns the others
  for (const id of ids) sim.post(id, { kind: 'discover', hosts: ids.filter((o) => o !== id).map((o) => `sim:${o}`) })
  sim.run({ until: 1000 })
  assert.ok(formed(nodes), 'the mesh closed through discover alone')
  assert.deepEqual(nodes.map((n) => n.epoch), [1, 1, 1], 'genesis over the discovered set')
  for (const n of nodes) assert.deepEqual(n.membership.view.members.map((m) => m[0]), ids)
  //! a late registrant: it discovers the members, they discover it — JOIN, not a second genesis
  const late = sim.add({ uuid: 'n04', listen: 'sim:n04', hosts: [], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n04', { kind: 'start' })
  sim.post('n04', { kind: 'discover', hosts: ids.map((o) => `sim:${o}`) })
  for (const id of ids) sim.post(id, { kind: 'discover', hosts: [...ids, 'n04'].filter((o) => o !== id).map((o) => `sim:${o}`) })
  sim.run({ until: 3000 })
  for (const n of [...nodes, late]) assert.deepEqual(n.membership.view.members.map((m) => m[0]), [...ids, 'n04'], `${n.uuid} installed the 4-member view`)
  assert.equal(late.epoch, 2, 'one JOIN ballot past genesis — never a second genesis')
  assert.deepEqual(sim.violations, [])
})
