//! Tier-2 door family (docs/DESIGN-DOOR.md §9): the handshake on seeded schedules — a secret on every
// member plus one intruder per seed under the chaos defaults (delay, dup, severOnFrame, crash and
// restart) at n=3..5. The sim proves the PROTOCOL with the toy door (sim/door.ts); node:crypto is the
// real-TCP tier's. What is checked where converged() runs: no intruder ever in any member's byUuid, view
// or lanes; no client link ever holds a member's uuid; the acceptor never proves before the dialer's
// proof reached it; nothing but HELLO/DOOR leaves a secured end before its own proof. Plus the counted
// handshake (4 frames per link), the forwarder (the address rule), and the determinism canary.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { toyDoor } from './door.ts'
import { JK } from '../kernel/journal.ts'
import { VERB, Framer, encodeControl } from '../kernel/codec.ts'
import { LS } from '../kernel/link.ts'
import { proofMsg, type Door, type HelloKeys } from '../kernel/door.ts'
import { stable, type Node } from '../kernel/node.ts'

const SECRET = 'door-family-secret-0001'
const dec = (b: Uint8Array) => new Framer().push(b)[0]
const rows = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind)
const reasons = (n: Node) => rows(n, JK.doorReject).map((e) => e.b as string)

//! agree — the members hold one state (the family's converged(): intruders are nodes too, and hold nothing)
const agree = (ms: Node[]): string | null => {
  const [ref, ...rest] = ms
  for (const n of rest) {
    if (n.stateHash !== ref.stateHash || n.state.size !== ref.state.size) return `${ref.uuid} vs ${n.uuid}: hash ${ref.stateHash} vs ${n.stateHash}, ${ref.state.size} vs ${n.state.size} cells`
    for (const [k, v] of ref.state) if (!n.state.has(k) || stable(n.state.get(k)) !== stable(v)) return `${ref.uuid} vs ${n.uuid} at ${k}`
  }
  return null
}

//! oracle — the frame-order laws, read off the tap. By the acceptor's link id: the dialer's DOOR {p} was
// shipped toward it before the acceptor shipped its own (a FIFO link: shipped before ⇒ read before, and
// the acceptor acts only on what it read); and no secured end ships anything but HELLO and DOOR before
// its own proof. Intruders that are kernel nodes are secured ends too (a wrong-secret dialer still
// proves first); raw endpoints are not nodes and are not judged.
const oracle = (sim: Sim, secured: Set<string>) => {
  const dialerProved = new Set<number>()
  const proved = new Set<string>()
  const bad: string[] = []
  sim.tap = (from, to, link, peerLink, dialed, bytes) => {
    const verb = bytes[2]
    if (verb === VERB.HELLO) return
    if (verb === VERB.DOOR) {
      const v = dec(bytes).value as { p?: unknown; e?: unknown }
      if (typeof v.p !== 'string') return // a notice
      if (dialed) { dialerProved.add(peerLink); if (!secured.has(from)) return } // any dialer's proof counts, raw endpoints included
      else {
        if (!secured.has(from)) return
        if (!dialerProved.has(link)) bad.push(`${from}: acceptor link ${link} proved before the dialer ${to} did`)
        const n = sim.nodes.get(from)
        if (n && rows(n, JK.doorReject).some((e) => e.a === link)) bad.push(`${from}: proved on link ${link} after refusing it`)
      }
      proved.add(from + '|' + link)
      return
    }
    if (secured.has(from) && !proved.has(from + '|' + link)) bad.push(`${from}: verb ${verb} left link ${link} before its own proof`)
  }
  return bad
}

//! rawClient — a hand-written CLIENT with the secret that claims `claim` as its uuid (the stray FERO_UUID):
// HELLO r:1 with a nonce, the dialer's proof over the server's HELLO, then whatever comes back.
const rawClient = (sim: Sim, id: string, claim: string, door: Door, got: string[]) => {
  const framers = new Map<number, Framer>()
  let myK = ''
  return sim.raw(id, null, (ev, sink) => {
    if (ev.kind === 'linkUp') {
      myK = door.nonce()
      framers.set(ev.link, new Framer())
      sink.send(ev.link, encodeControl(VERB.HELLO, { u: claim, i: 1, l: '', r: 1, k: myK }))
    } else if (ev.kind === 'bytesIn') {
      for (const f of framers.get(ev.link)!.push(ev.bytes)) {
        if (f.verb === VERB.HELLO) {
          const h = f.value as HelloKeys
          sink.send(ev.link, encodeControl(VERB.DOOR, { p: door.mac(proofMsg('dialer', h.k as string, myK, h.u, h.l, { u: claim, i: 1, l: '', r: 1 })) }))
        } else if (f.verb === VERB.DOOR) {
          const v = f.value as { e?: unknown }
          if (typeof v.e === 'string') got.push(v.e)
        }
      }
    }
  })
}

//! relay — the forwarder: a raw endpoint at `listen` that, when dialed, dials `target` and forwards every
// frame both ways. One session at a time; frames that arrive before the far side is up are held; the far
// link outlives the near one (a relay that keeps its victim waiting). With `rewrite`, the far side's HELLO
// is re-encoded with `l` = this relay's own address, so the address rule sees the claim it expects.
const relay = (sim: Sim, id: string, listen: string, target: string, rewrite = false) => {
  let acc: number | null = null, out: number | null = null
  const held: Uint8Array[] = []
  const back = new Framer()
  const toNear = (bytes: Uint8Array): Uint8Array[] =>
    !rewrite ? [bytes] : back.push(bytes).map((f) => f.verb === VERB.HELLO ? encodeControl(VERB.HELLO, { ...(f.value as Record<string, unknown>), l: listen }) : bytes)
  sim.raw(id, listen, (ev, sink) => {
    if (ev.kind === 'linkUp') {
      if (!ev.dialed) { acc = ev.link; sink.connect(target) }
      else { out = ev.link; for (const b of held) sink.send(out, b); held.length = 0 }
    } else if (ev.kind === 'bytesIn') {
      if (ev.link === acc) { if (out !== null) sink.send(out, ev.bytes); else held.push(ev.bytes) }
      else if (ev.link === out && acc !== null) for (const b of toNear(ev.bytes)) sink.send(acc, b)
    } else if (ev.kind === 'linkDown') {
      //! a sticky relay: the far link is kept open when the near one dies (the far member sits in proving
      // with no dialer proof — its deadline is what ends it); a dead far link closes the near one
      if (ev.link === acc) acc = null
      else if (ev.link === out) { out = null; if (acc !== null) { const a = acc; acc = null; sink.close(a, 'relay') } }
    }
  })
}

test('counted: a secured 2-node formation ships exactly 4 handshake frames per link (2 HELLO + 2 DOOR; the open wire ships 2), and nothing but HELLO/DOOR leaves either end before its own proof', () => {
  const count = (secured: boolean) => {
    const sim = new Sim(0)
    const door = secured ? toyDoor(SECRET, sim.rng) : undefined
    const perLink = new Map<string, number[]>()
    const bad = oracle(sim, new Set(secured ? ['n01', 'n02'] : []))
    const prev = sim.tap
    sim.tap = (from, to, link, peerLink, dialed, bytes) => {
      prev?.(from, to, link, peerLink, dialed, bytes)
      if (bytes[2] === VERB.HELLO || bytes[2] === VERB.DOOR) {
        const key = Math.min(link, peerLink) + '-' + Math.max(link, peerLink)
        ;(perLink.get(key) ?? perLink.set(key, []).get(key)!).push(bytes[2])
      }
    }
    const nodes = cluster(sim, 2, { fault: { delay: [1, 1] }, ...(door ? { door } : {}) })
    sim.run()
    assert.ok(formed(nodes))
    assert.deepEqual(bad, [])
    return { perLink: [...perLink.values()].map((v) => v.length), events: sim.events }
  }
  const open = count(false), sec = count(true)
  assert.deepEqual(open.perLink, [2, 2], 'open: one HELLO per end on each of the two dialed links')
  assert.deepEqual(sec.perLink, [4, 4], 'secured: two HELLOs and two DOORs on each link — exactly 4')
  assert.ok(sec.events > open.events, `the secured formation costs more events (${sec.events} vs ${open.events})`)
})

test('the door family: ~200 seeds, a secret on every member and one intruder per seed under the chaos defaults — never admitted, never in a view or a lane, the members form, converge and agree', () => {
  const failures: string[] = []
  const seen = { kinds: new Set<number>(), chaos: new Set<number>() }
  for (let seed = 0; seed < 200; seed++) {
    try {
      const n = 3 + (seed % 3)
      const sim = new Sim(seed)
      const door = toyDoor(SECRET, sim.rng)
      //! durable: a crashed member restarts FROM ITS DISK with its epoch (a memory-only rebirth would read as an epoch going backwards)
      const nodes = cluster(sim, n, { heartbeatMs: 50, door, durable: true })
      const members = nodes.map((x) => x.uuid)
      const addrs = members.map((u) => `sim:${u}`)
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) sim.fault(members[i], members[j], { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
      const secured = new Set(members)
      const bad = oracle(sim, secured)
      //! the per-event half of the role rule: a client link never holds a member's uuid once the view stands
      const memberSet = new Set(members)
      sim.monitors.push({
        name: 'no-client-holds-a-member-uuid',
        check: (s: Sim): string | null => {
          for (const [id, nd] of s.nodes) {
            if (!memberSet.has(id) || nd.epoch === 0) continue
            for (const l of nd.links.values()) if (l.client && l.state === LS.admitted && !l.dead && memberSet.has(l.uuid)) return `${id}: client link ${l.id} holds member uuid ${l.uuid}`
          }
          return null
        },
      })
      //! the intruder: 0 wrong secret · 1 no secret · 2 a client WITH the secret claiming a member's uuid ·
      // 3 a replay of a captured HELLO + DOOR on a fresh connection
      const kind = seed % 4
      seen.kinds.add(kind)
      let intruder: Node | null = null
      const got: string[] = []
      let captured: Uint8Array[] = []
      let before: unknown = null, dupBefore = -1
      if (kind === 0 || kind === 1) {
        intruder = sim.add({ uuid: 'zz', listen: 'sim:zz', hosts: addrs, heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, ...(kind === 0 ? { door: toyDoor('wrong-' + SECRET, sim.rng) } : {}) })
        if (kind === 0) secured.add('zz')
        sim.post('zz', { kind: 'start' })
        //! and a member is told about it (the directory's squatter): it dials, is refused, re-dials once per heartbeat.
        // Not the lowest-uuid member: genesis waits there for links ≥ hosts, discovered hosts included, so a
        // squatter it was told about would hold genesis for good (a V4-3 property, with or without a door)
        sim.at(10 + sim.rng() * 100, () => sim.post(members[n - 1], { kind: 'discover', hosts: ['sim:zz'] }))
      } else if (kind === 2) {
        const sink = rawClient(sim, 'zz', members[1], door, got)
        sim.at(1500, () => sink.connect(addrs[0]))
      } else {
        //! capture the first HELLO and DOOR {p} members[0] shipped as the DIALER toward members[1]
        const prev = sim.tap
        sim.tap = (from, to, link, peerLink, dialed, bytes) => {
          prev?.(from, to, link, peerLink, dialed, bytes)
          if (from === members[0] && to === members[1] && dialed && captured.length < 2 && (bytes[2] === VERB.HELLO || bytes[2] === VERB.DOOR)) captured.push(bytes)
        }
        const sink = sim.raw('zz', null, (ev, s) => { if (ev.kind === 'linkUp') for (const b of captured) s.send(ev.link, b) })
        sim.at(2499, () => { const t = sim.nodes.get(members[1])!; before = t.byUuid.get(members[0]); dupBefore = rows(t, JK.dupLink).length })
        sim.at(2500, () => sink.connect(addrs[1]))
      }
      //! chaos: 1 the first DOOR and a HELLO die on the wire (tail loss mid-handshake) · 2 a member crashes and restarts
      const chaos = seed % 3
      seen.chaos.add(chaos)
      if (chaos === 1) { sim.severOnFrame(members[0], members[1], VERB.DOOR, 1); sim.severOnFrame(members[2], members[1], VERB.HELLO, 1) }
      if (chaos === 2) {
        //! never the member the intruder's test reads: the squatting client's target (kind 2), or the member
        // told about the intruder (kinds 0/1 — a reborn node starts with an empty journal and no discover set)
        const pool = kind === 2 ? members.slice(1) : kind === 3 ? members : members.slice(0, n - 1)
        const victim = pool[Math.floor(sim.rng() * pool.length)]
        sim.at(600 + sim.rng() * 600, () => { sim.restart(victim) })
      }
      writes(sim, nodes, 10, 300)
      sim.at(3000, () => sim.post(members[0], { kind: 'write', recs: [{ type: 0, key: ['late'], value: seed }] }))
      sim.run({ until: 6000, maxEvents: 3_000_000 })
      const live = members.map((u) => sim.nodes.get(u)!)
      const problems: string[] = []
      if (sim.violations.length) problems.push(`monitor ${sim.violations[0].monitor}: ${sim.violations[0].detail}`)
      if (bad.length) problems.push(`oracle: ${bad[0]}`)
      if (!formed(live)) problems.push('members never formed')
      const dis = agree(live); if (dis) problems.push(`members disagree: ${dis}`)
      if (!live[0].state.has(JSON.stringify(['late']))) problems.push('the late write did not land')
      for (const m of live) {
        if (m.epoch === 0) problems.push(`${m.uuid} never installed a view`)
        for (const [u] of m.membership.view.members) if (!memberSet.has(u)) problems.push(`${m.uuid}: view holds ${u}`)
        if (m.byUuid.has('zz')) problems.push(`${m.uuid}: byUuid holds the intruder`)
        for (const o of m.logs.keys()) if (o.startsWith('zz')) problems.push(`${m.uuid}: a lane from the intruder`)
        for (const [o] of m.streams) if (o.startsWith('zz')) problems.push(`${m.uuid}: a stream from the intruder`)
        for (const l of m.links.values()) if (l.client && !l.dead) problems.push(`${m.uuid}: a live client link (${l.uuid})`)
      }
      if (intruder !== null) {
        if (intruder.admitted().length) problems.push('the intruder admitted someone')
        if (intruder.epoch !== 0 || intruder.byUuid.size) problems.push('the intruder learned a view or a peer')
        const r = reasons(intruder)
        if (kind === 0 && !r.some((x) => x === 'refused' || x === 'bad-proof')) problems.push(`wrong-secret intruder saw ${r.join(',')}`)
        if (kind === 1 && !r.includes('peer-secret')) problems.push(`no-secret intruder saw ${r.join(',')}`)
        const mr = live.flatMap(reasons)
        if (kind === 0 && !mr.includes('bad-proof')) problems.push(`members never refused the wrong secret's own dials: ${mr.join(',')}`)
        if (kind === 0 && !reasons(live[n - 1]).includes('refused')) problems.push(`the member that dialed the wrong secret never read its refusal: ${reasons(live[n - 1]).join(',')}`)
        if (kind === 1 && !mr.includes('no-secret')) problems.push(`members never refused the missing secret: ${mr.join(',')}`)
      }
      if (kind === 2) {
        if (!reasons(live[0]).includes('uuid-taken')) problems.push(`the target never refused the squatting client: ${reasons(live[0]).join(',')}`)
        if (!got.includes('uuid-taken')) problems.push(`the client never read the notice (${got.join(',')})`)
        for (const m of live) if (m.uuid !== members[1]) { const l = m.links.get(m.byUuid.get(members[1])!); if (!l || l.client) problems.push(`${m.uuid}: ${members[1]}'s link is ${l ? 'a client link' : 'gone'}`) }
      }
      if (kind === 3) {
        const t = live[1]
        if (captured.length !== 2) problems.push(`captured ${captured.length} frames`)
        if (!reasons(t).includes('bad-proof')) problems.push(`the replay was not refused bad-proof: ${reasons(t).join(',')}`)
        if (t.byUuid.get(members[0]) !== before) problems.push(`the real member's link moved: ${String(before)} → ${String(t.byUuid.get(members[0]))}`)
        if (rows(t, JK.dupLink).length !== dupBefore) problems.push('the replay produced a dupLink row')
      }
      if (problems.length) failures.push(`seed ${seed} (n=${n}, intruder ${kind}, chaos ${chaos}): ${problems.join('; ')}`)
    } catch (e) {
      failures.push(`seed ${seed}: threw ${e}`)
    }
  }
  assert.deepEqual(seen, { kinds: new Set([0, 1, 2, 3]), chaos: new Set([0, 1, 2]) }, 'every intruder and every chaos ran')
  assert.deepEqual(failures, [])
})

test('the forwarder: a relay behind a DISCOVERED address is refused by the address rule before any proof (the far member times out); one that REWRITES the far HELLO to its own address gets the dialer\'s proof, which the far member reads as bad-proof; behind a STATIC host it is admitted — the documented limit until TLS', () => {
  const build = (viaStatic: boolean, rewrite = false) => {
    const sim = new Sim(7)
    const door = toyDoor(SECRET, sim.rng)
    const a = sim.add({ uuid: 'n01', listen: 'sim:n01', hosts: viaStatic ? ['sim:x'] : [], heartbeatMs: 50, door, redialMs: 20, journalCap: 1 << 16 })
    const b = sim.add({ uuid: 'n02', listen: 'sim:n02', hosts: [], heartbeatMs: 50, door, redialMs: 20, journalCap: 1 << 16 })
    relay(sim, 'x', 'sim:x', 'sim:n02', rewrite)
    sim.post('n01', { kind: 'start' }); sim.post('n02', { kind: 'start' })
    if (!viaStatic) sim.at(5, () => sim.post('n01', { kind: 'discover', hosts: ['sim:x'] }))
    sim.run({ until: 7000, maxEvents: 1_000_000 })
    return { a, b, sim }
  }
  //! discovered: n01 dialed sim:x, the peer says it is sim:n02 — someone in between
  { const { a, b } = build(false)
    assert.ok(rows(a, JK.doorReject).some((e) => e.b === 'address' && e.c === 'sim:n02'), `n01 refused the relay: ${JSON.stringify(rows(a, JK.doorReject).slice(0, 3))}`)
    assert.deepEqual(a.admitted(), [], 'never admitted through the relay')
    assert.deepEqual(b.admitted(), [])
    assert.ok(reasons(b).includes('timeout'), `n02 never got a dialer proof and timed out: ${reasons(b).join(',')}`)
    assert.ok(rows(a, JK.revive).length >= 1, 'the parked target is re-dialed once per heartbeat — bounded chatter, no admission') }
  //! discovered, rewritten: x answers as sim:x, so the address rule passes and n01 proves — over the listen it was
  // shown. n02 rebuilds over the listen it SENT (sim:n02): bad-proof, the notice rides back, n01 parks sim:x.
  { const { a, b } = build(false, true)
    assert.deepEqual(rows(a, JK.doorReject).filter((e) => e.b === 'address'), [], 'the address rule cannot see the rewrite')
    assert.ok(rows(b, JK.doorReject).some((e) => e.b === 'bad-proof' && e.c === 'sim:n01'), `n02 refused the relayed proof: ${JSON.stringify(rows(b, JK.doorReject).slice(0, 3))}`)
    assert.ok(reasons(a).includes('refused'), `n01 read the notice through the relay: ${reasons(a).join(',')}`)
    assert.deepEqual(a.admitted(), [], 'never admitted through the relay'); assert.deepEqual(b.admitted(), [])
    assert.equal(b.byUuid.has('n01'), false); assert.deepEqual(rows(b, JK.identified), [])
    assert.ok(rows(a, JK.revive).length >= 1, 'bounded chatter, no admission') }
  //! static: the operator typed sim:x — exempt, the handshake completes THROUGH the relay (TLS's job later)
  { const { a, b } = build(true)
    assert.deepEqual(a.admitted(), ['n02'], 'admitted: a relay at a static host is NOT PROTECTED (DESIGN-DOOR §7)')
    assert.deepEqual(b.admitted(), ['n01'])
    assert.deepEqual(rows(a, JK.doorReject), []) }
})

test('determinism canary, secured: the same seed twice — a secret, an intruder, writes and chaos — gives the same event count and the same trace', () => {
  const once = () => {
    const sim = new Sim(4242)
    const door = toyDoor(SECRET, sim.rng)
    const nodes = cluster(sim, 3, { heartbeatMs: 50, door, fault: { delay: [1, 20], dupP: 0.3 } })
    sim.add({ uuid: 'zz', listen: 'sim:zz', hosts: ['sim:n01', 'sim:n02'], heartbeatMs: 50, redialMs: 20, door: toyDoor('other-secret-value-01', sim.rng) })
    sim.post('zz', { kind: 'start' })
    sim.severOnFrame('n01', 'n02', VERB.DOOR, 1)
    writes(sim, nodes, 20)
    sim.at(700, () => { sim.restart('n03') })
    sim.run({ until: 3000 })
    return { events: sim.events, trace: sim.trace.join(',') }
  }
  const a = once(), b = once()
  assert.equal(a.events, b.events)
  assert.equal(a.trace, b.trace)
})
