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
import { JK } from './journal.ts'
import { TAG, type EffectSink, type Env } from './env.ts'
import { Sim } from '../sim/exec.ts'
import { formed } from '../sim/harness.ts'
import { toyDoor } from '../sim/door.ts'

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

//! ── the genesis gate (wave 6b, 2026-10-12; DESIGN-DIRECTORY §13, narrowed after its first review). Genesis at the
// lowest-uuid member waits for links ≥ hosts, and hosts counts the discovered set, so a squatter the directory handed out
// held the first view for good. Now a DIALED target that answered for ANOTHER RESOURCE NAME leaves the count — permanent
// and symmetric, another resource for good. Every other target stays in it: one that merely never answers (dead and cut
// look the same from here) AND one that refused this node's contract or its proof — the same process with its config
// fixed is one of us, and counting it out let two halves of one host list each form a view at epoch 1 that never merged
// (the review's probe) — so genesis waits on it, and the composer's refusal line says so (api/index.ts genesisWaits). ──
test('the genesis gate: a DIALED target that answers for another name leaves the count — aa, the lowest, told of bb and the squatter zz, forms {aa,bb}@1 at the next heartbeat once zz refused it (the base waited for links ≥ hosts for good); a target that never answers (its chain gave up) stays in the count; a refused target that admits later is a link again', () => {
  const { node, of, fire } = harness('aa', { name: 'r', hosts: ['sim:bb', 'sim:zz'], heartbeatMs: 100 })
  const heartbeat = () => fire(of('timer').filter((e) => e[2] === TAG.heartbeat).pop()!) // the LAST armed heartbeat (the harness's fires the first)
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb', 'sim:bb', 'r') })
  assert.deepEqual(node.admitted(), ['bb'])
  //! zz never answers: every dial refused until the chain gives up — still counted, no genesis (CP: a dead entry and a cut
  // look the same from here, and two halves of one host list must never each form a view)
  node.step({ kind: 'linkDown', link: 2, reason: 'refused', to: 'sim:zz' })
  for (let i = 0; i < 12; i++) {
    const t = of('timer').filter((e) => e[2] === TAG.redial).pop()
    if (!t) break
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    node.step({ kind: 'linkDown', link: 10 + i, reason: 'refused', to: 'sim:zz' })
  }
  assert.ok(!node.dialing('sim:zz') && !node.refused('sim:zz'), 'given up, not refused')
  heartbeat()
  assert.equal(node.epoch, 0, 'no genesis: zz is still waited for')
  assert.equal(node.journal.read().filter((e) => e.kind === JK.propose).length, 0)
  //! zz answers the DIALED link for another resource: name-mismatch — a stranger, out of the count
  const dial = of('connect').filter((e) => e[1] === 'sim:zz').length
  assert.ok(dial >= 2, 'the heartbeat revived the given-up dial')
  node.step({ kind: 'linkUp', link: 30, dialed: true, to: 'sim:zz' })
  node.step({ kind: 'bytesIn', link: 30, bytes: hello('zz', 'sim:zz', 'other') })
  assert.deepEqual(of('close').at(-1), ['close', 30, 'name-mismatch'])
  assert.ok(node.refused('sim:zz'), 'remembered as a stranger')
  node.step({ kind: 'linkDown', link: 30, reason: 'name-mismatch', to: 'sim:zz' })
  heartbeat()
  assert.equal(node.epoch, 0, 'proposed, not yet committed')
  assert.deepEqual(node.journal.read().filter((e) => e.kind === JK.propose).map((e) => [e.a, e.b]), [[1, 2]], 'genesis over the admitted set: {aa,bb}, zz not waited for')
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb' }) })
  assert.equal(node.epoch, 1)
  assert.deepEqual(node.membership.view.members.map((m) => m[0]), ['aa', 'bb'])
  //! the right resource moves onto zz's port later and admits: the refusal is forgotten — by the address I DIALED (it may
  // claim another listen on the open path), and by the listen it CLAIMS when it is the one that dialed me
  node.step({ kind: 'linkUp', link: 40, dialed: true, to: 'sim:zz' })
  node.step({ kind: 'bytesIn', link: 40, bytes: hello('zz', 'sim:zz-alias', 'r') })
  assert.ok(!node.refused('sim:zz'), 'admitted on my dial: no longer a stranger, whatever listen it claims')
  assert.deepEqual(node.admitted().sort(), ['bb', 'zz'])
  node.step({ kind: 'linkDown', link: 40, reason: 'close', to: 'sim:zz' })
  node.step({ kind: 'linkUp', link: 41, dialed: true, to: 'sim:zz' })
  node.step({ kind: 'bytesIn', link: 41, bytes: hello('zz', 'sim:zz', 'other') })
  assert.ok(node.refused('sim:zz'), 'refused again on a later dial')
  node.step({ kind: 'linkDown', link: 41, reason: 'name-mismatch', to: 'sim:zz' })
  node.step({ kind: 'linkUp', link: 42, dialed: false })
  node.step({ kind: 'bytesIn', link: 42, bytes: hello('zz', 'sim:zz', 'r') })
  assert.ok(!node.refused('sim:zz'), 'admitted on ITS dial, claiming the listen I had refused: forgotten too')
})

test('the genesis gate, the door and the contract: a dialed target with NO secret where I have one, one that refuses my proof (the DOOR notice), one with another cluster contract, a proving TIMEOUT and a `uuid-taken` notice ALL stay in the count (as first built the first three left it: a fixable mismatch across one host list formed two clusters that never merged); only a target that answers for another NAME leaves it — forgotten with the target when the directory forgets it, kept for a static host', () => {
  const door = toyDoor('s', () => 0.5)
  const { node, of } = harness('aa', { name: 'r', hosts: ['sim:tt', 'sim:uu', 'sim:ss', 'sim:qq'], heartbeatMs: 100, door, contract: 'v1;heartbeat.ms=100;replicas=1;methods=0;validation=none' })
  node.step({ kind: 'start' })
  node.step({ kind: 'discover', hosts: ['sim:nn', 'sim:pp', 'sim:mm'] })
  //! nn: no `k` on its HELLO — no-secret, refused at HELLO time; counted (the same process with FERO_SECRET set is one of us)
  node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:nn' })
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('nn', 'sim:nn') })
  assert.deepEqual(of('close').at(-1), ['close', 2, 'door'])
  assert.ok(!node.refused('sim:nn'), 'no-secret stays in the count')
  //! pp: a HELLO with `k`, then a refusal notice for my proof — counted (the secrets differ; one fix and it is one of us)
  node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:pp' })
  node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', k: 'a'.repeat(32) }) })
  assert.equal(node.links.get(3)!.proved, true, 'the dialer proved at HELLO time')
  node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DOOR, { e: 'denied' }) })
  assert.deepEqual(of('close').at(-1), ['close', 3, 'door'])
  assert.ok(!node.refused('sim:pp'), 'a refused proof stays in the count')
  //! qq: another cluster contract (replicas=2 against my 1) — contractReject, counted (the review's probe: counting it
  // out let each half of one list form its own view at epoch 1, and fixing the contract could not merge them)
  node.step({ kind: 'linkUp', link: 7, dialed: true, to: 'sim:qq' })
  node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'qq', i: 1, l: 'sim:qq', c: 'v1;heartbeat.ms=100;replicas=2;methods=0;validation=none', k: 'd'.repeat(32) }) })
  assert.deepEqual(of('close').at(-1), ['close', 7, 'contract-mismatch'])
  assert.deepEqual(node.journal.read().filter((e) => e.kind === JK.contractReject).map((e) => [e.b, e.c]), [['replicas', '2']])
  assert.ok(!node.refused('sim:qq'), 'a contract mismatch stays in the count')
  //! ss: a static host that answers for another name — out of the count, and kept (a static host is never forgotten)
  node.step({ kind: 'linkUp', link: 6, dialed: true, to: 'sim:ss' })
  node.step({ kind: 'bytesIn', link: 6, bytes: encodeControl(VERB.HELLO, { u: 'ss', i: 1, l: 'sim:ss', n: 'other', k: 'e'.repeat(32) }) })
  assert.ok(node.refused('sim:ss'), 'name-mismatch before any proof: another resource, out of the count')
  //! mm: a discovered target that answers for another name — out of the count until the directory forgets it
  node.step({ kind: 'linkUp', link: 8, dialed: true, to: 'sim:mm' })
  node.step({ kind: 'bytesIn', link: 8, bytes: encodeControl(VERB.HELLO, { u: 'mm', i: 1, l: 'sim:mm', n: 'other', k: 'f'.repeat(32) }) })
  assert.ok(node.refused('sim:mm'))
  //! tt: a HELLO with `k`, then silence — the proving deadline refuses it `timeout`, and it stays counted
  node.step({ kind: 'linkUp', link: 4, dialed: true, to: 'sim:tt' })
  node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.HELLO, { u: 'tt', i: 1, l: 'sim:tt', k: 'b'.repeat(32) }) })
  const prove = of('timer').filter((e) => e[2] === TAG.prove).pop()!
  node.step({ kind: 'timer', id: prove[1] as number, tag: TAG.prove })
  assert.deepEqual(of('close').at(-1), ['close', 4, 'door-timeout'])
  assert.ok(!node.refused('sim:tt'), 'a timeout is not a refusal: the peer may be one of us with a frame lost')
  //! uu: the far side holds a member running as me — `uuid-taken` is MY misconfiguration, counted
  node.step({ kind: 'linkUp', link: 5, dialed: true, to: 'sim:uu' })
  node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HELLO, { u: 'uu', i: 1, l: 'sim:uu', k: 'c'.repeat(32) }) })
  node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.DOOR, { e: 'uuid-taken' }) })
  assert.deepEqual(of('close').at(-1), ['close', 5, 'door'])
  assert.ok(!node.refused('sim:uu'))
  //! the directory forgets nn, pp and mm: mm's name refusal goes with it; ss, static, keeps its
  node.step({ kind: 'discover', hosts: [] })
  assert.ok(!node.refused('sim:mm'), 'a name refusal is remembered only for a target the node still dials')
  assert.ok(node.refused('sim:ss'))
})

//! the gate WAITS on a door or contract refusal (the narrowing): with bb admitted and the one other host refusing — the
// secret, or the contract — the count still wants it, so no ballot opens; red as first built (it proposed {aa,bb}@1)
test('the genesis gate waits, loudly, on a same-name host that refuses this node: aa, the lowest, with bb admitted and the only other host refusing at the door (it has a secret, aa has none) or for its contract proposes NOTHING at the heartbeat — the host is one of us with a config fix, and counting it out split one list into two clusters; a host that answers for another name is not waited for (the test above)', () => {
  for (const tag of ['peer-secret', 'contract'] as const) {
    const { node, of, fire } = harness('aa', { name: 'r', hosts: ['sim:bb', 'sim:zz'], heartbeatMs: 100, contract: 'v1;heartbeat.ms=100;replicas=1;methods=0;validation=none' })
    const heartbeat = () => fire(of('timer').filter((e) => e[2] === TAG.heartbeat).pop()!)
    const mine = node.contract! // the kernel appends its ring (`;ring=…`): a peer must echo the whole string
    const close = tag === 'contract' ? 'contract-mismatch' : 'door'
    const bytes = tag === 'contract'
      ? encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', c: mine.replace('replicas=1', 'replicas=2') })
      : encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', c: mine, k: 'a'.repeat(32) })
    node.step({ kind: 'start' })
    node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
    node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', c: mine }) })
    assert.deepEqual(node.admitted(), ['bb'], tag)
    node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:zz' })
    node.step({ kind: 'bytesIn', link: 2, bytes })
    assert.deepEqual(of('close').at(-1), ['close', 2, close], tag)
    assert.ok(!node.refused('sim:zz'), `${tag}: still counted`)
    node.step({ kind: 'linkDown', link: 2, reason: close, to: 'sim:zz' })
    heartbeat()
    assert.equal(node.epoch, 0, `${tag}: no view`)
    assert.equal(node.journal.read().filter((e) => e.kind === JK.propose).length, 0, `${tag}: genesis waits on zz (as first built: {aa,bb}@1 proposed here)`)
  }
})

test('the genesis gate, the guard: a host list cut in two halves never forms two views — four members told of each other, {n01,n02} cut from {n03,n04} before the start; every chain gives up and gives up again at every heartbeat, and nobody forms a view (a closed port and a cut look the same); the heal forms ONE view of four', () => {
  const sim = new Sim(11)
  const ids = ['n01', 'n02', 'n03', 'n04']
  const nodes = ids.map((id) => sim.add({ uuid: id, listen: `sim:${id}`, hosts: ids.filter((o) => o !== id).map((o) => `sim:${o}`), heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 }))
  for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.partition(a, b)
  for (const id of ids) sim.post(id, { kind: 'start' })
  sim.run({ until: 4000 })
  assert.deepEqual(nodes.map((n) => n.epoch), [0, 0, 0, 0], 'CP at genesis: each half waits for the other, for good')
  assert.ok(nodes.every((n) => n.journal.read().some((e) => e.kind === JK.giveUp)), 'every chain gave up at least once')
  assert.ok(nodes.every((n) => n.journal.read().filter((e) => e.kind === JK.propose).length === 0), 'nobody proposed')
  for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.heal(a, b)
  sim.run({ until: 7000 })
  assert.ok(formed(nodes))
  assert.deepEqual(nodes.map((n) => n.epoch), [1, 1, 1, 1], 'one view at epoch 1 once the halves meet')
  for (const n of nodes) assert.deepEqual(n.membership.view.members.map((m) => m[0]), ids)
  assert.deepEqual(sim.violations, [])
})
