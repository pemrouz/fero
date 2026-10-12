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
import { cluster, client, formed, writes } from './harness.ts'
import { toyDoor, toyClientDoor, toyClientKey } from './door.ts'
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
// HELLO r:1 with a nonce, the dialer's proof over the server's HELLO — a CLIENT-KEY proof, as every r:1
// dialer's is (§15; the door derives it from the secret) — then whatever comes back.
const rawClient = (sim: Sim, id: string, claim: string, door: Door, got: string[]) => {
  const framers = new Map<number, Framer>()
  let myK = ''
  const mac = (m: string) => (door.clientMac !== undefined ? door.clientMac(m) : door.mac(m))
  return sim.raw(id, null, (ev, sink) => {
    if (ev.kind === 'linkUp') {
      myK = door.nonce()
      framers.set(ev.link, new Framer())
      sink.send(ev.link, encodeControl(VERB.HELLO, { u: claim, i: 1, l: '', r: 1, k: myK }))
    } else if (ev.kind === 'bytesIn') {
      for (const f of framers.get(ev.link)!.push(ev.bytes)) {
        if (f.verb === VERB.HELLO) {
          const h = f.value as HelloKeys
          sink.send(ev.link, encodeControl(VERB.DOOR, { p: mac(proofMsg('dialer', h.k as string, myK, h.u, h.l, { u: claim, i: 1, l: '', r: 1 })) }))
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

test('the honest crossing dial, secured, heartbeats OFF: a formation of members that all hold the secret writes NO doorReject row (the keeper close that overtakes the acceptor\'s proof is not a refusal), and after a cut the pair heals — n=2 and n=3, 40 seeds each, plain and under the dup and wide-delay faults', () => {
  //! the sim posts a close after the minimum delay and bytes after a random one, so the dup-link loser's close
  // can reach the still-proving dialer before the acceptor's proof. Before the fix (the second review's major)
  // 46 to 60 of 60 seeds wrote `refused` against an honest member and parked it given-up; with heartbeats off
  // nothing clears a park, so that side never re-dialed the peer after a cut.
  const faults = [undefined, { dupP: 0.3 }, { delay: [1, 9] as [number, number] }]
  let formations = 0
  for (const n of [2, 3]) for (const fault of faults) for (let seed = 1; seed <= 40; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, n, { door: toyDoor(SECRET, sim.rng), ...(fault !== undefined ? { fault } : {}) })
    sim.run()
    const tag = `n=${n} fault=${JSON.stringify(fault)} seed ${seed}`
    assert.ok(formed(nodes), `${tag}: formed`)
    for (const x of nodes) assert.deepEqual(rows(x, JK.doorReject).map((e) => [e.b, e.c]), [], `${tag}: ${x.uuid} refused an honest member`)
    formations++
    //! a cut and a heal 3 ms later, heartbeats off: both ends re-dial on their chains (neither is parked), the pair re-forms
    sim.partition('n01', 'n02')
    sim.at(3, () => sim.heal('n01', 'n02'))
    sim.run()
    assert.ok(formed(nodes), `${tag}: healed after the cut`)
    for (const x of nodes) assert.deepEqual(rows(x, JK.doorReject), [], `${tag}: ${x.uuid} refused an honest member while healing`)
  }
  assert.equal(formations, 240)
})

test('a cut DURING the handshake, secured, heartbeats OFF (the third review\'s major): a pair of members (n=2 and n=3) and a server + client, partitioned at t = 0..9 ms for 3 ms while they are still proving — every schedule heals, and no doorReject row ever names an honest peer; 30 seeds × 8 cut times each', () => {
  //! a bare close while proving used to be journaled `refused` and the target parked given-up; with heartbeats
  // off nothing clears a park, so 41 of these 480 pairs never formed (260 rows against honest members) and 68
  // of 210 clients never got a primary. A bare close is a link loss now: the ordinary bounded chain re-dials.
  // The open door is the control: it healed every schedule before and after.
  for (const secured of [false, true]) {
    let pairs = 0, clients = 0
    for (const n of [2, 3]) for (let seed = 1; seed <= 30; seed++) for (const t of [0, 1, 2, 3, 4, 5, 7, 9]) {
      const sim = new Sim(seed)
      const nodes = cluster(sim, n, secured ? { door: toyDoor(SECRET, sim.rng) } : {})
      sim.at(t, () => sim.partition('n01', 'n02'))
      sim.at(t + 3, () => sim.heal('n01', 'n02'))
      sim.run()
      const tag = `${secured ? 'secured' : 'open'} n=${n} seed ${seed} cut at ${t}`
      assert.ok(formed(nodes), `${tag}: formed after the cut`)
      for (const x of nodes) assert.deepEqual(rows(x, JK.doorReject).map((e) => [e.b, e.c]), [], `${tag}: ${x.uuid} refused an honest member`)
      pairs++
    }
    for (let seed = 1; seed <= 30; seed++) for (const t of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const sim = new Sim(seed)
      const door = secured ? toyDoor(SECRET, sim.rng) : undefined
      const [s] = cluster(sim, 1, door ? { door } : {})
      const c = client(sim, 'c01', [s], door ? { door } : {})
      sim.at(t, () => sim.partition('n01', 'c01'))
      sim.at(t + 3, () => sim.heal('n01', 'c01'))
      sim.run()
      const tag = `${secured ? 'secured' : 'open'} client seed ${seed} cut at ${t}`
      assert.ok(c.primary !== null && c.admitted().includes('n01'), `${tag}: the client has its feeder`)
      assert.ok(s.admitted().includes('c01'), `${tag}: the server holds the client`)
      for (const x of [s, c]) assert.deepEqual(rows(x, JK.doorReject).map((e) => [e.b, e.c]), [], `${tag}: ${x.uuid} wrote a refusal`)
      clients++
    }
    assert.equal(pairs, 480); assert.equal(clients, 240)
  }
})

test('the door family: ~200 seeds, a secret on every member and one intruder per seed under the chaos defaults — never admitted, never in a view or a lane, the members form, converge and agree; on the even seeds where the LOWEST member was told of a same-name squatter it waits, loudly, and nothing forms (the data still agrees)', () => {
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
      // 3 a replay of a captured HELLO + DOOR on a fresh connection · 4 a holder of the CLIENT KEY alone that
      // joins as a member (§15: no r:1, so every member checks its proof with the secret)
      const kind = seed % 5
      seen.kinds.add(kind)
      let intruder: Node | null = null
      const got: string[] = []
      let captured: Uint8Array[] = []
      let before: unknown = null, dupBefore = -1
      if (kind === 0 || kind === 1 || kind === 4) {
        const bad = kind === 0 ? toyDoor('wrong-' + SECRET, sim.rng) : kind === 4 ? toyClientDoor(toyClientKey(SECRET), sim.rng) : undefined
        intruder = sim.add({ uuid: 'zz', listen: 'sim:zz', hosts: addrs, heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, ...(bad !== undefined ? { door: bad } : {}) })
        if (bad !== undefined) secured.add('zz')
        sim.post('zz', { kind: 'start' })
        //! and a member is told about it (the directory's squatter): it dials, is refused, re-dials once per heartbeat.
        // On even seeds the LOWEST member is told too (the genesis gate, wave 6b, 2026-10-12, narrowed after its first
        // review: a same-name dialer that refuses it at the DOOR stays in its genesis count — it is one of us with its
        // secret fixed, and counting it out split one host list into two clusters that never merged — so the lowest member
        // waits, loudly, and no view forms on those seeds; only a target that answers for another NAME leaves the count,
        // kernel/discover.test.ts). Its link to zz has a fixed delay so the refusal notice lands before the close, as TCP
        // delivers it (the sim's random-delay close model loses the notice, DESIGN-DOOR §3): a wrong secret and the client
        // key are refused by zz's notice, no secret at HELLO time. One rng draw either way.
        const told = 10 + sim.rng() * 100
        if (seed % 2 === 0) sim.fault(members[0], 'zz', { delay: [2, 2] })
        sim.at(told, () => sim.post(members[n - 1], { kind: 'discover', hosts: ['sim:zz'] }))
        //! the lowest is told BEFORE its first heartbeat at 50 ms (the same draw, scaled to 10..45, no extra draw): told
        // after it, it may already have proposed genesis over the formed mesh, and the shape would read two ways
        if (seed % 2 === 0) sim.at(10 + (told - 10) * 0.35, () => sim.post(members[0], { kind: 'discover', hosts: ['sim:zz'] }))
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
        // told about the intruder (kinds 0/1 — a reborn node starts with an empty journal and no discover set); the
        // lowest member, told too on even seeds, may restart: reborn without the discover set it waits for nobody
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
      //! the genesis gate (DESIGN-DIRECTORY §13, narrowed after wave 6b's first review): on even seeds the LOWEST member was
      // told of the squatter before any view formed, and a same-name dialer with a wrong secret (or none) is NOT counted
      // out — it is one of us with its config fixed, and counting it out split one host list into two clusters — so the
      // lowest member WAITS, loudly (its refusal row on its own dial; the composer prints the line), and nobody forms a view.
      // A lowest member reborn by chaos 2 has no discover set and forms. The data still agrees: at epoch 0 every member's
      // gate is open and the admitted mesh replicates.
      const waits = seed % 2 === 0 && (kind === 0 || kind === 1 || kind === 4) && (chaos !== 2 || live[0].incarnation === 1)
      if (!formed(live)) problems.push('members never formed') // the MESH (every member admitted every other): it closes either way
      const dis = agree(live); if (dis) problems.push(`members disagree: ${dis}`)
      if (!live[0].state.has(JSON.stringify(['late']))) problems.push('the late write did not land')
      for (const m of live) {
        if (waits ? m.epoch !== 0 : m.epoch === 0) problems.push(waits ? `${m.uuid} installed a view at ${m.epoch} while genesis waits` : `${m.uuid} never installed a view`)
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
        //! a wrong secret and a client key posing as a member look the same to every member: bad-proof
        const wrongKey = kind === 0 || kind === 4
        if (wrongKey && !r.some((x) => x === 'refused' || x === 'bad-proof')) problems.push(`wrong-key intruder saw ${r.join(',')}`)
        if (kind === 1 && !r.includes('peer-secret')) problems.push(`no-secret intruder saw ${r.join(',')}`)
        const mr = live.flatMap(reasons)
        if (wrongKey && !mr.includes('bad-proof')) problems.push(`members never refused the wrong key's own dials: ${mr.join(',')}`)
        //! the member that DIALED the wrong secret: the intruder refused its proof (bad-proof, naming the member's
        // listen) and the notice it shipped rides BEHIND its close in the sim (a close lands at the pair's minimum
        // delay, a frame at a random one), so the member reads a bare close — a link loss, not a refusal: no row
        // (the third review), the ordinary chain re-dials, every door row it holds names the intruder, and it never
        // admits it. Real TCP delivers the notice (the api tier reads `refused`); the sim proves the lost-notice path.
        if (wrongKey) {
          const d = live[n - 1]
          if (!rows(intruder, JK.doorReject).some((e) => e.b === 'bad-proof' && e.c === addrs[n - 1])) problems.push(`the intruder never refused the member's own dial: ${reasons(intruder).join(',')}`)
          if (!rows(d, JK.doorReject).every((e) => e.c === 'sim:zz')) problems.push(`${d.uuid}: a door row names someone but the intruder: ${JSON.stringify(rows(d, JK.doorReject).map((e) => [e.b, e.c]))}`)
          //! a REDIAL row, not a dial row: the discover itself writes JK.dial at the moment of discovery, so a dial row
          // toward sim:zz is there under a park too; only the chain writes JK.redial (a park writes none)
          if (!rows(d, JK.redial).some((e) => e.b === 'sim:zz')) problems.push(`${d.uuid} never re-dialed the intruder on the chain after the bare close — no redial row toward sim:zz (a park?): ${rows(d, JK.dial).filter((e) => e.a === 'sim:zz').length} dial(s), ${rows(d, JK.redial).filter((e) => e.b === 'sim:zz').length} redial(s)`)
        }
        //! the genesis gate: the lowest member, told of zz on even seeds, read a refusal on its own dial (`refused` from
        // the notice, or `no-secret` at HELLO time) — loudly — and KEEPS WAITING for it (`waits` above is the teeth: no
        // view forms; the squatter is the same-name wrong-secret dialer, one of us with its secret fixed)
        if (waits) {
          const low = live[0]
          if (!rows(low, JK.doorReject).some((e) => (e.b === 'refused' || e.b === 'no-secret') && e.c === 'sim:zz')) problems.push(`${low.uuid} never read a refusal on its own dial to the intruder: ${JSON.stringify(rows(low, JK.doorReject).map((e) => [e.b, e.c]))}`)
          if (low.refused('sim:zz')) problems.push(`${low.uuid} counted the intruder out (a door refusal must keep it in the count)`)
          if (rows(low, JK.propose).length) problems.push(`${low.uuid} proposed a view while it counts the intruder`)
        }
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
  assert.deepEqual(seen, { kinds: new Set([0, 1, 2, 3, 4]), chaos: new Set([0, 1, 2]) }, 'every intruder and every chaos ran')
  assert.deepEqual(failures, [])
})

//! the genesis gate alone (wave 6b, 2026-10-12; DESIGN-DIRECTORY §13, narrowed after its first review): the LOWEST member
// is told of a same-name squatter at the door and nothing else happens — no chaos, no other intruder. It reads the
// refusal on its own dial (`refused` from the notice, `no-secret` at HELLO time) — the row the composer prints as the
// refusal line with "the first view waits on it" — and WAITS: a door refusal keeps the target in the count, since the
// same process with its secret fixed is one of us, and counting it out let each consistent half of one host list form
// its own view at epoch 1 (the review's probe: two clusters under one name, never merged). So no view forms on any seed,
// as on the base; what is new is the row, and the composer's line. As first built the gate counted the squatter out and
// formed; that pin is replaced by this one. The pair's delay is fixed so the DOOR notice lands before the close, as TCP
// delivers it (the sim's random-delay close model loses it, DESIGN-DOOR §3). The permanent refusal — another resource
// NAME — leaves the count and forms: kernel/discover.test.ts, the first genesis-gate test.
test('the genesis gate: the lowest member told of a same-name squatter — a wrong secret, no secret, or the client key alone — reads the refusal on its own dial and WAITS, loudly: no view forms, nothing is proposed, the squatter stays in the count (one of us with its secret fixed) and is never admitted; 30 seeds at n 3..5', () => {
  const failures: string[] = []
  for (let seed = 0; seed < 30; seed++) {
    const n = 3 + (seed % 3)
    const sim = new Sim(1000 + seed)
    const door = toyDoor(SECRET, sim.rng)
    const nodes = cluster(sim, n, { heartbeatMs: 50, door })
    const members = nodes.map((x) => x.uuid)
    const addrs = members.map((u) => `sim:${u}`)
    const kind = seed % 3 // 0 wrong secret · 1 no secret · 2 the client key alone
    const bad = kind === 0 ? toyDoor('wrong-' + SECRET, sim.rng) : kind === 2 ? toyClientDoor(toyClientKey(SECRET), sim.rng) : undefined
    const intruder = sim.add({ uuid: 'zz', listen: 'sim:zz', hosts: addrs, heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, ...(bad !== undefined ? { door: bad } : {}) })
    sim.post('zz', { kind: 'start' })
    sim.fault(members[0], 'zz', { delay: [2, 2] })
    sim.at(5 + sim.rng() * 30, () => sim.post(members[0], { kind: 'discover', hosts: ['sim:zz'] })) // before the first heartbeat at 50 ms
    sim.run({ until: 4000, maxEvents: 2_000_000 })
    const problems: string[] = []
    if (sim.violations.length) problems.push(`monitor ${sim.violations[0].monitor}`)
    if (!formed(nodes)) problems.push('the mesh never closed') // the members admit each other either way; the VIEW is what waits
    for (const m of nodes) {
      if (m.epoch !== 0) problems.push(`${m.uuid} at epoch ${m.epoch}`)
      if (rows(m, JK.propose).length) problems.push(`${m.uuid} proposed`)
      if (m.byUuid.has('zz')) problems.push(`${m.uuid}: byUuid holds the intruder`)
    }
    if (intruder.epoch !== 0 || intruder.byUuid.size) problems.push('the intruder learned a view or a peer')
    const low = nodes[0]
    const want = kind === 1 ? 'no-secret' : 'refused'
    if (!rows(low, JK.doorReject).some((e) => e.b === want && e.c === 'sim:zz')) problems.push(`${low.uuid} never read \`${want}\` on its own dial: ${JSON.stringify(rows(low, JK.doorReject).map((e) => [e.b, e.c]))}`)
    if (low.refused('sim:zz')) problems.push(`${low.uuid} counted the intruder out`)
    if (problems.length) failures.push(`seed ${seed} (n=${n}, intruder ${kind}): ${problems.join('; ')}`)
  }
  assert.deepEqual(failures, [])
})

test('the client key (§15): a process that holds ONLY the client key follows a secured server — admitted r:1, fed, its write lands, the handshake stays 4 frames per link — and the same door on a node that joins as a member is bad-proof at every member and admits nobody; 20 seeds under the chaos defaults', () => {
  for (let seed = 0; seed < 20; seed++) {
    const sim = new Sim(seed)
    const door = toyDoor(SECRET, sim.rng)
    const nodes = cluster(sim, 2, { heartbeatMs: 50, door, fault: { delay: [1, 1 + sim.rng() * 10], dupP: sim.rng() * 0.2 } })
    const perLink = new Map<string, number>()
    sim.tap = (_from, _to, link, peerLink, _dialed, bytes) => {
      if (bytes[2] === VERB.HELLO || bytes[2] === VERB.DOOR) { const key = Math.min(link, peerLink) + '-' + Math.max(link, peerLink); perLink.set(key, (perLink.get(key) ?? 0) + 1) }
    }
    const c = client(sim, 'c01', nodes, { heartbeatMs: 50, door: toyClientDoor(toyClientKey(SECRET), sim.rng) })
    const poser = sim.add({ uuid: 'zz', listen: 'sim:zz', hosts: ['sim:n01', 'sim:n02'], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, door: toyClientDoor(toyClientKey(SECRET), sim.rng) })
    sim.post('zz', { kind: 'start' })
    sim.at(400, () => sim.post('c01', { kind: 'write', recs: [{ type: 0, key: ['from-client'], value: seed }] }))
    sim.run({ until: 3000 })
    const tag = `seed ${seed}`
    //! not formed(): a member that holds the client admits n peers, not n - 1
    assert.ok(nodes.every((m) => nodes.every((o) => o === m || m.admitted().includes(o.uuid))), `${tag}: the members formed`)
    assert.ok(c.primary !== null && c.admitted().length >= 1, `${tag}: the client-key client has a feeder`)
    for (const m of nodes) {
      assert.ok(m.admitted().includes('c01') && m.links.get(m.byUuid.get('c01')!)?.client === true, `${tag}: ${m.uuid} holds the client as a CLIENT link`)
      assert.deepEqual(rows(m, JK.doorReject).map((e) => [e.b, e.c]).filter(([, c]) => c !== 'sim:zz'), [], `${tag}: ${m.uuid} refused someone but the poser`)
      assert.ok(rows(m, JK.doorReject).some((e) => e.b === 'bad-proof' && e.c === 'sim:zz'), `${tag}: ${m.uuid} never refused the poser's own dial bad-proof: ${JSON.stringify(reasons(m))}`)
      assert.equal(m.byUuid.has('zz'), false, `${tag}: ${m.uuid} holds the poser`)
      assert.ok(m.state.has(JSON.stringify(['from-client'])), `${tag}: the client's write landed at ${m.uuid}`)
    }
    assert.deepEqual(rows(c, JK.doorReject), [], `${tag}: the client was never refused`)
    assert.deepEqual(poser.admitted(), [], `${tag}: the poser admitted someone`)
    assert.equal(poser.epoch, 0, `${tag}: the poser learned a view`)
    //! the per-link count: every handshake that completed (admitted on both ends) cost exactly 2 HELLO + 2 DOOR
    assert.ok([...perLink.values()].every((v) => v <= 4), `${tag}: a link carried more than 4 handshake frames: ${JSON.stringify([...perLink])}`)
  }
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
  // shown. n02 rebuilds over the listen it SENT (sim:n02): bad-proof, and its notice rides back — BEHIND its close
  // in the sim (a close lands at the pair's minimum delay, a frame at a random one), so the relay sees the far link
  // die first and closes the near one: n01 reads a bare close, a link loss (no row; the third review), re-dials on
  // the ordinary chain, then at heartbeat revival — bounded chatter, never an admission. A read notice would park
  // sim:x with a `refused` row naming it (the kernel test); either way no row names anyone but sim:x.
  { const { a, b } = build(false, true)
    assert.deepEqual(rows(a, JK.doorReject).filter((e) => e.b === 'address'), [], 'the address rule cannot see the rewrite')
    assert.ok(rows(b, JK.doorReject).some((e) => e.b === 'bad-proof' && e.c === 'sim:n01'), `n02 refused the relayed proof: ${JSON.stringify(rows(b, JK.doorReject).slice(0, 3))}`)
    assert.ok(rows(a, JK.doorReject).every((e) => e.b === 'refused' && e.c === 'sim:x'), `n01 holds no door row but a refusal of sim:x: ${JSON.stringify(rows(a, JK.doorReject).slice(0, 3))}`)
    assert.ok(rows(a, JK.redial).some((e) => e.b === 'sim:x'), `n01 re-dialed the relay on the chain after the bare close — a redial row toward sim:x (the discover's own dial row is there under a park too; a park writes no redial): ${JSON.stringify(rows(a, JK.redial).slice(0, 3))}`)
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

//! the sim's restart and the old life's queue (STATUS 2026-10-09, the third review's probe): a reborn node
// numbers its timers from 1 again, and the sim's cancel is a no-op, so the first life's fires stayed
// queued. Its proving deadlines (armed at formation, due at tune.proveMs) were the loud case: a member
// restarted just before they fell due read each stale fire as one of its OWN deadlines — a TAG.prove at
// 12 ms instead of 5000 — and refused the honest peer it was proving `timeout`. Every member here holds
// the secret, so a `timeout` row at any member is a false refusal. Heartbeats OFF: nothing revives a
// falsely parked peer, so a false refusal here is also a pair that never re-forms. The exec drops an
// earlier life's echoes at the queue now (sim/exec.ts #life).
test('restarts under chaos with a secret and heartbeats OFF: a member reborn as its first life\'s proving deadlines fall due, and one reborn mid-formation, 60 seeds each — no `timeout` row at any honest member, the members re-form and agree, and the same seed twice gives the same trace', () => {
  const failures: string[] = []
  const once = (seed: number, when: 'deadline' | 'forming') => {
    const sim = new Sim(seed)
    const n = 3 + (seed % 3)
    const door = toyDoor(SECRET, sim.rng)
    const nodes = cluster(sim, n, { heartbeatMs: 0, door, durable: true })
    const ids = nodes.map((x) => x.uuid)
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) sim.fault(ids[i], ids[j], { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
    writes(sim, nodes, 10, 300)
    const victim = ids[Math.floor(sim.rng() * n)]
    //! deadline: the crash lands in the 20 ms before the first life's proving deadlines (5000 after its
    // HELLOs) fall due. forming: the crash lands while the first life is still proving its peers.
    sim.at(when === 'deadline' ? 4985 + sim.rng() * 20 : 2 + sim.rng() * 40, () => { sim.restart(victim) })
    sim.run({ until: 12000, maxEvents: 3_000_000 })
    return { sim, live: ids.map((u) => sim.nodes.get(u)!) }
  }
  for (const when of ['deadline', 'forming'] as const) {
    for (let seed = 0; seed < 60; seed++) {
      const { sim, live } = once(seed, when)
      const problems: string[] = []
      if (sim.violations.length) problems.push(`monitor ${sim.violations[0].monitor}: ${sim.violations[0].detail}`)
      for (const m of live) {
        const t = rows(m, JK.doorReject).filter((e) => e.b === 'timeout')
        if (t.length) problems.push(`${m.uuid} refused an honest peer timeout ${t.length}× (${t.map((e) => e.c).join(',')})`)
      }
      if (!formed(live)) problems.push('the members never re-formed')
      const dis = agree(live); if (dis) problems.push(`members disagree: ${dis}`)
      if (problems.length) failures.push(`seed ${seed} (n=${live.length}, ${when}): ${problems.join('; ')}`)
    }
  }
  assert.deepEqual(failures, [])
  //! the determinism canary over a restart: the dropped echoes are part of the seeded trajectory
  const a = once(7, 'deadline'), b = once(7, 'deadline')
  assert.equal(a.sim.events, b.sim.events)
  assert.equal(a.sim.trace.join(','), b.sim.trace.join(','))
})
