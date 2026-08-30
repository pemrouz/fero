//! Tier-1/2 discover suite (V4-3): the `discover` event — the dynamic host set the directory feeds the
// kernel — against the recording sink (dial / cover / park / re-add / static-never-parked), and genesis
// over a DISCOVERED set in the sim (a mesh whose static hosts are all empty forms only through
// discover; a late registrant joins at the next epoch through the ordinary JOIN path).

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
  return { node, effects, of, connects, redials }
}
const hello = (u: string, l = `sim:${u}`) => encodeControl(VERB.HELLO, { u, i: 1, l })

test('discover: added targets dial (own listen excluded), node.hosts is static ∪ dynamic, and the cache re-derives on change', () => {
  const { node, connects } = harness('aa', { hosts: ['sim:st'] })
  node.step({ kind: 'start' })
  assert.deepEqual(connects(), ['sim:st'])
  node.step({ kind: 'discover', hosts: ['sim:bb', 'sim:aa', 'sim:cc', 'sim:bb'] })
  assert.deepEqual(connects().slice(1), ['sim:bb', 'sim:cc'], 'new targets dial once each; own listen and duplicates are dropped')
  assert.deepEqual(node.hosts, ['sim:st', 'sim:bb', 'sim:cc'])
  const cached = node.hosts
  assert.equal(node.hosts, cached, 'the per-tick readers get the cached array, not a fresh allocation')
  node.step({ kind: 'discover', hosts: ['sim:bb'] })
  assert.deepEqual(node.hosts, ['sim:st', 'sim:bb'], 'replaced wholesale')
  //! a listen assignment (the shell's port-0 publish) invalidates the cache: own listen leaves the set
  node.listen = 'sim:bb'
  assert.deepEqual(node.hosts, ['sim:st'])
})

test('discover: a target a live link already covers is not re-dialed (dialed `to` OR the gossiped listen)', () => {
  const { node, connects } = harness('aa')
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'linkUp', link: 2, dialed: false }) // cc dialed US — covered by its gossiped listen
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('cc') })
  node.step({ kind: 'discover', hosts: ['sim:bb', 'sim:cc', 'sim:dd'] })
  assert.deepEqual(connects(), ['sim:dd'], 'only the uncovered target dials')
  assert.deepEqual(node.hosts, ['sim:bb', 'sim:cc', 'sim:dd'], 'covered targets still count as hosts (genesis quorum)')
})

test('discover: a forgotten target PARKS — its redial chain stops at the next failure and revival ignores it; re-adding dials afresh', () => {
  const { node, connects, redials, of } = harness('aa', { heartbeatMs: 100 })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:cc'] })
  assert.deepEqual(connects(), ['sim:cc'])
  node.step({ kind: 'linkDown', link: 7, reason: 'refused', to: 'sim:cc' }) // a failed dial → the chain arms
  assert.equal(redials().length, 1)
  assert.ok(node.dialing('sim:cc'), 'an active chain reports dialing (eviction hold)')
  node.step({ kind: 'discover', hosts: [] })
  assert.deepEqual(node.hosts, [])
  assert.equal(node.dialing('sim:cc'), false, 'parked: no longer "actively trying"')
  //! the armed timer still fires once (the one extra dial the design allows) — then the chain STOPS
  const t = redials()[0]
  node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
  assert.equal(connects().length, 2)
  node.step({ kind: 'linkDown', link: 8, reason: 'refused', to: 'sim:cc' })
  assert.equal(redials().length, 1, 'no new redial after the park: the chain is at the cap')
  //! the heartbeat's give-up revival never lists a forgotten target
  const hb = of('timer').find((e) => e[2] === TAG.heartbeat)!
  node.step({ kind: 'timer', id: hb[1] as number, tag: TAG.heartbeat })
  assert.equal(connects().length, 2, 'not revived')
  //! re-add: the park clears and a fresh dial goes out
  node.step({ kind: 'discover', hosts: ['sim:cc'] })
  assert.equal(connects().length, 3)
  assert.equal(connects()[2], 'sim:cc')
})

test('discover: a STATIC host or a committed member is never parked by a discover that omits it', () => {
  const { node, connects, of } = harness('aa', { hosts: ['sim:st'], heartbeatMs: 100 })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:st'] })
  assert.equal(connects().length, 1, 'a static host is already dialing — not re-dialed')
  node.step({ kind: 'linkDown', link: 1, reason: 'refused', to: 'sim:st' })
  for (let i = 0; i < MAX_REDIALS + 1; i++) {
    const t = of('timer').filter((e) => e[2] === TAG.redial).at(-1)!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    node.step({ kind: 'linkDown', link: 100 + i, reason: 'refused', to: 'sim:st' })
  }
  node.step({ kind: 'discover', hosts: [] }) // omits the static host
  assert.deepEqual(node.hosts, ['sim:st'], 'static hosts survive every discover')
  const before = connects().length
  const hb = of('timer').find((e) => e[2] === TAG.heartbeat)!
  node.step({ kind: 'timer', id: hb[1] as number, tag: TAG.heartbeat })
  assert.equal(connects().length, before + 1, 'give-up revival still dials the static host')
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
  assert.ok(late.epoch >= 2)
  assert.deepEqual(sim.violations, [])
})
