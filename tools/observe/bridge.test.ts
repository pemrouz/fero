// tools/observe/bridge.ts — the L4 observer bridge. End-to-end coverage of the
// Slice-0 pull pipe: server internals → (network CALL | in-process seam) → bridge →
// SSE → a consuming client. Plus the wire gate: __inspect is unreachable without observe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fero, diagnostics } from '../../resource/index.ts'
import type { InspectSnapshot } from '../../resource/inspect.ts'
import { value } from '../../../data/index.ts'
import { ports, until, sleep, connected } from '#utils'
import { bridge, networkSource, inProcessSource, deriveAggregate } from './bridge.ts'

//! Minimal SSE consumer: parse `event:`/`data:` blocks off the raw stream — snapshots into `got`, flattened provenance events into `recs` (stands in for the browser's EventSource).
const readSSE = (port: number) => {
  const got: InspectSnapshot[] = []
  const recs: any[] = []
  const aggs: any[] = []
  const provs: any[] = []
  const debugs: any[] = []
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    res.setEncoding('utf8')
    let buf = ''
    res.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let ev = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        try {
          if (ev === 'snapshot') got.push(JSON.parse(data))
          else if (ev === 'records') for (const r of JSON.parse(data)) recs.push(r)
          else if (ev === 'aggregate') aggs.push(JSON.parse(data))
          else if (ev === 'provagg') provs.push(JSON.parse(data))
          else if (ev === 'debug') debugs.push(JSON.parse(data))
        } catch {
          /* partial — ignore */
        }
      }
    })
  })
  req.on('error', () => {})
  return { got, recs, aggs, provs, debugs, close: () => req.destroy() }
}

//! Fabricate an InspectSnapshot — the bridge aggregation is source-agnostic over this shape, so a stub source of these validates the rollup (and 200-node scale) WITHOUT a real mesh.
const fakeSnap = (uuid: string, epoch: number, members: string[], writable: boolean, extra: Partial<InspectSnapshot> = {}): InspectSnapshot =>
  ({
    name: 'syn', uuid, me: `127.0.0.1:${uuid}`, role: 'server', epoch, members, writable,
    ring: { coverage: [], members, replicas: 3, scoped: true } as any,
    log: { size: 100, partitions: 1, heads: {} }, marks: {}, versions: 0, pending: 0, orphans: [],
    subscriptions: 0, peers: [], at: 0, ...extra,
  }) as InspectSnapshot

//! A non-network Source serving a fixed array of fabricated snapshots (mutable so a test can flip the scenario).
const stubSource = (snaps: { current: InspectSnapshot[] }) => ({
  targets: () => snaps.current.map((s) => s.me!),
  inspect: async (t: string) => snaps.current.find((s) => s.me === t),
  destroy: () => {},
})

test('in-process source: snapshots of every node reach an SSE client', async () => {
  const p1 = await ports.free()
  const p2 = await ports.free()
  const A = await fero('obs-ip', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('obs-ip', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, B.cluster.me!) && connected(B.cluster, A.cluster.me!), 6000), 'A↔B meshed')

  const b = await bridge({ source: inProcessSource([A, B]), port: 0, poll: 100 })
  const sse = readSSE(b.port)
  try {
    // both nodes' self-reports must arrive, keyed by their distinct uuids
    assert.ok(
      await until(() => {
        const ids = new Set(sse.got.map((s) => s.uuid))
        return ids.has(A.cluster.uuid) && ids.has(B.cluster.uuid)
      }, 6000),
      'snapshots for both A and B arrived',
    )
    const a = sse.got.find((s) => s.uuid === A.cluster.uuid)!
    assert.equal(a.role, 'server')
    assert.equal(a.me, A.cluster.me)
    assert.ok(a.ring.members.includes(A.cluster.me!), 'A sees itself in the ring')
  } finally {
    sse.close()
    await b.close()
    A.destroy()
    B.destroy()
  }
})

//! P5 live mode: the bridge ships a `debug` DebugFile each poll, consumable through the SAME normalize() the file-fed viewer uses
test('live debug feed: the bridge relays a store-once DebugFile that the viewer normalize() accepts', async () => {
  const p1 = await ports.free()
  const p2 = await ports.free()
  const A = await fero('obs-dbg', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('obs-dbg', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'a 2-member view committed')
  A.data.alpha = { v: 1 }
  B.data.beta = { v: 2 }
  const b = await bridge({ source: inProcessSource([A, B]), port: 0, poll: 100 })
  const sse = readSSE(b.port)
  try {
    const ready = (f: any) => { const r = f.resources?.find((x: any) => x.name === 'obs-dbg'); return r?.members?.length === 2 && r?.partitions?.length >= 2 }
    assert.ok(await until(() => sse.debugs.some(ready), 6000), 'a debug file with the committed 2-member view and the written partitions arrived')
    const file = [...sse.debugs].reverse().find(ready)
    assert.equal(file['fero.debug'], 1)
    const r = file.resources.find((x: any) => x.name === 'obs-dbg')
    assert.ok(r, 'the resource is present')
    assert.equal(r.members.length, 2)
    // owner is authoritative — the live debug owner matches cluster.owner ground truth
    for (const p of r.partitions) assert.equal(p.owner, A.cluster.owner(p.name), `live owner of ${p.name} matches cluster.owner`)
    // and it round-trips through the viewer's normalize() (the one seam both feeds share)
    const { normalize } = await import('../debug/mockups/shape.js')
    const model = normalize(file)
    assert.equal(model.resources.find((x: any) => x.id === 'obs-dbg').members, 2)
  } finally {
    sse.close()
    await b.close()
    A.destroy()
    B.destroy()
  }
})

//! P5: the promoted debug viewer is served same-origin at /debug/ so it can EventSource /events
test('the bridge serves the debug viewer at /debug/ (same-origin with the live feed)', async () => {
  const A = await fero('obs-serve', { port: await ports.free(), wait: 10 })
  const b = await bridge({ source: inProcessSource([A]), port: 0, poll: 200 })
  try {
    const get = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: b.port, path }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode!, body }))
        })
      })
    const tree = await get('/debug/')
    assert.equal(tree.status, 200)
    assert.match(tree.body, /import \{ normalize/, 'serves tree.html (the normalize-driven viewer)')
    const shape = await get('/debug/shape.js')
    assert.equal(shape.status, 200)
    assert.match(shape.body, /export function normalize/, 'serves the shared shape.js seam')
  } finally {
    await b.close()
    A.destroy()
  }
})

test('network source: bridge dials an observe server and relays its snapshot over SSE', async () => {
  const p = await ports.free()
  const S = await fero('obs-net', { host: '127.0.0.1', port: p, ports: [p], wait: 100, observe: true })
  S.data.k = { v: 1 }

  const b = await bridge({ source: networkSource({ seeds: [S.cluster.me!], name: 'obs-net' }), port: 0, poll: 200 })
  const sse = readSSE(b.port)
  try {
    assert.ok(
      await until(() => sse.got.some((s) => s.uuid === S.cluster.uuid), 8000),
      'a snapshot for the dialed server arrived over the wire',
    )
    const snap = sse.got.find((s) => s.uuid === S.cluster.uuid)!
    assert.equal(snap.name, 'obs-net')
    assert.ok(snap.log.size >= 1, 'the write is reflected in the snapshot')
  } finally {
    sse.close()
    await b.close() // also destroys the source mesh
    S.destroy()
  }
})

test('observe stream: provenance events flow node → bridge → SSE, batched + `by`-attributed', async () => {
  const p1 = await ports.free()
  const p2 = await ports.free()
  const A = await fero('obs-stream', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, observe: true })
  const B = await fero('obs-stream', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, observe: true })
  assert.ok(await until(() => connected(A.cluster, B.cluster.me!) && connected(B.cluster, A.cluster.me!), 6000), 'A↔B meshed')

  const b = await bridge({ source: inProcessSource([A, B]), port: 0, poll: 150, flush: 50 })
  const sse = readSSE(b.port)
  try {
    await sleep(120) // let the bridge open its observe subs before writing
    A.data.k1 = { v: 1 } // A owns or forwards; either way both nodes emit provenance
    B.data.k2 = { v: 2 }
    // wait for the SPECIFIC write keys, not just any 2 events — keyless formation events
    // (view/writable) would otherwise satisfy a raw count before the writes' provenance lands.
    assert.ok(
      await until(() => {
        const ks = new Set(sse.recs.map((r) => r.key))
        return ks.has('k1') && ks.has('k2')
      }, 6000),
      `both written keys appear (saw ${[...new Set(sse.recs.map((r) => r.key))].join(',')})`,
    )
    // every relayed event carries the flat provenance shape + the observing-node attribution
    for (const r of sse.recs) {
      assert.ok(typeof r.kind === 'string', 'has a kind')
      assert.ok(typeof r.by === 'string', 'is attributed to the node that observed it')
      assert.equal('value' in r, false, 'never carries the data value (provenance only)')
    }
  } finally {
    sse.close()
    await b.close()
    A.destroy()
    B.destroy()
  }
})

test('wire gate: __inspect is unreachable without observe (the call rejects → undefined)', async () => {
  const p = await ports.free()
  const S = await fero('obs-gate', { host: '127.0.0.1', port: p, ports: [p], wait: 100 }) // NO observe
  const src = networkSource({ seeds: [S.cluster.me!], name: 'obs-gate' })
  try {
    assert.ok(await until(() => src.targets().length > 0, 6000), 'bridge mesh connected to the server')
    const snap = await src.inspect(S.cluster.me!)
    assert.equal(snap, undefined, 'no snapshot — __inspect is not registered, so the call rejects')
  } finally {
    src.destroy()
    S.destroy()
  }
})

// ── scale tier: the bridge's 'aggregate' rollup (view-groups + 3-state convergence + top-K lag) ──
// Validated with a SYNTHETIC source (fabricated snapshots) — the aggregation is source-agnostic
// over InspectSnapshot, so this proves the O(groups+topK) collapse + the partition rendering at
// N the in-process harness can't reach, and is the regression guard for the war-game views.

const addrs = (n: number, base = 0) => Array.from({ length: n }, (_, i) => `127.0.0.1:${base + i}`)

test('aggregate: a converged N-node cluster rolls up to ONE view-group; per-node snapshots suppressed (blobs mode)', async () => {
  const members = addrs(50)
  const snaps = { current: members.map((_, i) => fakeSnap(String(i), 5, members, true)) }
  const b = await bridge({ source: stubSource(snaps) as any, port: 0, poll: 60, aggregateAbove: 5 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sse.aggs.length >= 2, 4000), 'aggregate events arrived')
    const a = sse.aggs.at(-1)
    assert.equal(a.mode, 'blobs', 'N=50 > threshold → blobs mode')
    assert.equal(a.conv.state, 'converged', 'one shared view → converged')
    assert.equal(a.groups.length, 1, 'exactly one view-group')
    assert.equal(a.groups[0].reps, 50, 'all 50 nodes in it')
    assert.equal(a.totals.nodes, 50)
    // blobs mode suppresses the per-node fan-out — and accounts the drop (no silent loss)
    assert.equal(sse.got.length, 0, 'no per-node snapshot events in blobs mode')
    assert.ok(a.dropped.snapshots > 0, 'dropped count is reported')
  } finally {
    sse.close()
    await b.close()
  }
})

test('aggregate: a 30/20 split-brain rolls up to TWO writable-MAJORITY groups → partition state', async () => {
  const A = addrs(30, 0) // 30 nodes, their own committed view
  const B = addrs(20, 100) // 20 nodes, a DIFFERENT committed view (each a majority of its own set)
  const snaps = {
    current: [
      ...A.map((_, i) => fakeSnap('a' + i, 7, A, true)), // writable majority of {30}
      ...B.map((_, i) => fakeSnap('b' + i, 6, B, true)), // writable majority of {20} — split-brain
    ],
  }
  const b = await bridge({ source: stubSource(snaps) as any, port: 0, poll: 60, aggregateAbove: 5 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sse.aggs.length >= 2, 4000), 'aggregate events arrived')
    const a = sse.aggs.at(-1)
    assert.equal(a.conv.state, 'partition', '≥2 writable majorities → split-brain')
    assert.equal(a.conv.writableMajorities, 2, 'both sides are writable majorities')
    assert.equal(a.groups.length, 2, 'two view-group blobs')
    const sizes = a.groups.map((g: any) => g.reps).sort((x: number, y: number) => y - x)
    assert.deepEqual(sizes, [30, 20], 'a 30-blob and a 20-blob')
    assert.ok(a.groups.every((g: any) => g.majority && g.writable), 'both are writable majorities')
  } finally {
    sse.close()
    await b.close()
  }
})

test('aggregate: a clean majority/minority partition (minority read-only) is NOT split-brain; lone rejoiner folds into others', async () => {
  const A = addrs(30, 0)
  const B = addrs(20, 100)
  const snaps = {
    current: [
      ...A.map((_, i) => fakeSnap('a' + i, 7, A, true)), // 30 writable majority
      ...B.map((_, i) => fakeSnap('b' + i, 5, B, false)), // 20 minority that correctly went READ-ONLY
      fakeSnap('solo', 1, ['127.0.0.1:solo'], true), // a lone pre-join rejoiner (writable, members=[self])
    ],
  }
  const b = await bridge({ source: stubSource(snaps) as any, port: 0, poll: 60, aggregateAbove: 5 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sse.aggs.length >= 2, 4000), 'aggregate events arrived')
    const a = sse.aggs.at(-1)
    assert.equal(a.conv.state, 'converging', 'only ONE writable majority → converging, not partition')
    assert.equal(a.conv.writableMajorities, 1, 'the read-only minority + solo rejoiner are not writable majorities')
    // the solo rejoiner (reps 1) folds into the bounded "others" blob, not its own
    const others = a.groups.find((g: any) => g.sig === 'others')
    assert.ok(others, 'singletons folded into an others blob')
    assert.ok(!a.groups.some((g: any) => g.sig !== 'others' && g.reps < 2), 'no singleton blobs survive')
  } finally {
    sse.close()
    await b.close()
  }
})

// ── Stage C: key-movement heatmap (`cover`) + provenance rollup (`provagg`) ──────

test('aggregate: consensus `cover` resolves the largest view\'s ownership donut to owner ADDRESSES', () => {
  // coverage[i] is a member-INDEX into ring.members; the rollup resolves it to the comparable
  // owner ADDRESS so the dashboard can diff successive covers into the key-movement heatmap.
  const members = ['127.0.0.1:10', '127.0.0.1:11', '127.0.0.1:12']
  const coverage = [0, 0, 1, 2, 2, 2]
  const snaps = members.map((_, i) => fakeSnap(String(i), 5, members, true, { ring: { coverage, members, replicas: 3, scoped: false } as any }))
  const a = deriveAggregate(snaps, 'blobs', 0)
  assert.deepEqual(a.cover, ['127.0.0.1:10', '127.0.0.1:10', '127.0.0.1:11', '127.0.0.1:12', '127.0.0.1:12', '127.0.0.1:12'], 'each segment → its owner address')
})

test('aggregate: `cover` follows the MAJORITY view during a partition + maps an unowned segment to ""', () => {
  const A = addrs(4, 0) // the majority view (4 nodes) — its ring is authoritative
  const B = addrs(2, 100) // a minority view (2 nodes) with DIFFERENT ownership — must not win the cover
  const covA = [0, 1, -1, 3] // segment 2 is unowned (index -1) → ''
  const covB = [1, 1, 0, 0]
  const snaps = [
    ...A.map((_, i) => fakeSnap('a' + i, 7, A, true, { ring: { coverage: covA, members: A, replicas: 3, scoped: false } as any })),
    ...B.map((_, i) => fakeSnap('b' + i, 6, B, true, { ring: { coverage: covB, members: B, replicas: 3, scoped: false } as any })),
  ]
  const a = deriveAggregate(snaps, 'blobs', 0)
  assert.deepEqual(a.cover, [A[0], A[1], '', A[3]], 'cover came from the 4-node majority view; unowned → ""')
})

//! A stub Source that also drives the PUSH leg — captures each target's onRecord so a test can inject provenance.
const provStubSource = (snaps: { current: InspectSnapshot[] }) => {
  const sinks: Array<(rec: any) => void> = []
  return {
    targets: () => snaps.current.map((s) => s.me!),
    inspect: async (t: string) => snaps.current.find((s) => s.me === t),
    observe: (_t: string, onRecord: (rec: any) => void) => { sinks.push(onRecord); return () => {} },
    emit: (rec: any) => { for (const s of sinks) s({ key: [], value: rec }) }, // value carries the flat ProvRecord
    destroy: () => {},
  }
}

test('provagg: at scale the bridge ships the provenance ROLLUP (rates + top-K keys/origins) and SUPPRESSES the raw firehose', async () => {
  const members = addrs(30)
  const snaps = { current: members.map((_, i) => fakeSnap(String(i), 5, members, true)) }
  const src = provStubSource(snaps)
  const b = await bridge({ source: src as any, port: 0, poll: 60, aggregateAbove: 5 })
  const sse = readSSE(b.port)
  // inject writes: 'hot' written far more than 'cold'; origin o1 the busiest writer — on a 50ms beat so
  // whichever 1s provagg window the timer catches sees them (the rollup fires once/second).
  const beat = setInterval(() => {
    for (let i = 0; i < 5; i++) src.emit({ kind: 'local', origin: 'o1', key: 'hot' })
    src.emit({ kind: 'forwarded', origin: 'o2', key: 'cold' })
    src.emit({ kind: 'lost', origin: 'o3', key: 'fight', epoch: 5, we: 5 }) // same-epoch → a TRUE conflict
  }, 50)
  try {
    assert.ok(await until(() => sse.provs.some((p) => p.keys.length > 0), 4000), 'a provagg rollup with hot keys arrived')
    const p = sse.provs.findLast((p: any) => p.keys.length > 0)
    assert.ok(p.rates.writes > 0, 'writes/s computed from the window')
    assert.equal(p.keys[0].key, 'hot', 'top hot key is the most-written')
    assert.equal(p.origins[0].origin, 'o1', 'top origin is the busiest writer')
    assert.ok(p.rates.conflicts >= 1, 'a same-epoch loser is counted as a conflict')
    assert.equal(p.nodes, 30, 'rollup reports how many node streams it folds')
    // the raw per-record firehose must NOT reach the browser at scale (the whole point)
    assert.equal(sse.recs.length, 0, 'no raw records events in blobs mode')
  } finally {
    clearInterval(beat)
    sse.close()
    await b.close()
  }
})

test('aggregate: top-K lag ranks worst-behind nodes (floor-relative, live-origin) and caps at K', async () => {
  const members = addrs(50)
  // origin "0" has written up to seq 1000 cluster-wide; node i has replicated seq (1000 - i*5) of it
  const snaps = {
    current: members.map((_, i) => fakeSnap(String(i), 5, members, true, { marks: { ['0']: 1000 - i * 5 } as any })),
  }
  const b = await bridge({ source: stubSource(snaps) as any, port: 0, poll: 60, aggregateAbove: 5 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sse.aggs.length >= 2, 4000), 'aggregate events arrived')
    const a = sse.aggs.at(-1)
    assert.ok(a.topLag.length <= 20, 'capped at K=20')
    // node 49 is furthest behind (seq 755 vs frontier 1000); node 0 is the leader (floor)
    assert.equal(a.topLag[0].excess >= a.topLag[1].excess, true, 'ranked worst-first')
    assert.ok(a.topLag.every((l: any, i: number) => i === 0 || a.topLag[i - 1].excess >= l.excess), 'monotonically non-increasing')
  } finally {
    sse.close()
    await b.close()
  }
})

// ── review fixes: idle arming, ghost uuid, dump dedup, push-leg revival ─────────

test('idle arming: with NO SSE client the bridge opens no push legs; a client arms them, its exit disarms', async () => {
  const members = addrs(2)
  const snaps = { current: members.map((_, i) => fakeSnap(String(i), 2, members, true)) }
  let opened = 0
  let closed = 0
  const src = {
    ...stubSource(snaps),
    observe: (_t: string, _on: (rec: any) => void) => { opened++; return () => { closed++ } },
  }
  const b = await bridge({ source: src as any, port: 0, poll: 40 })
  try {
    await sleep(160) // several ticks with nobody watching
    assert.equal(opened, 0, 'no dashboard ⇒ no push legs ⇒ no node pays the watched write tax')
    const sse = readSSE(b.port)
    assert.ok(await until(() => opened === 2, 3000), 'a client arms one push leg per target')
    sse.close()
    assert.ok(await until(() => closed === 2, 3000), 'the last client leaving disarms every push leg')
  } finally {
    await b.close()
  }
})

test('same-address restart: the old uuid is pruned from the rollup (no ghost node poisoning aggregates)', async () => {
  const members = addrs(3)
  const snaps = { current: members.map((_, i) => fakeSnap(String(i), 2, members, true)) }
  const b = await bridge({ source: stubSource(snaps) as any, port: 0, poll: 40 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sse.aggs.some((a) => a.totals.nodes === 3), 3000), 'all three folded')
    // "restart" node 1: same address, NEW uuid (the address-only prune can't catch this — the address stays live)
    snaps.current = members.map((_, i) =>
      i === 1 ? fakeSnap('1b', 2, members, true, { me: members[1] }) : fakeSnap(String(i), 2, members, true),
    )
    await sleep(250) // several ticks past the swap
    const a = sse.aggs.at(-1)
    assert.equal(a.totals.nodes, 3, `the dead uuid was pruned (a ghost would make it 4; got ${a.totals.nodes})`)
  } finally {
    sse.close()
    await b.close()
  }
})

test('initial __observe dump is HISTORY: it seeds the watermark, never the rates; replays dedup by t', async () => {
  const members = addrs(2)
  const snaps = { current: members.map((_, i) => fakeSnap(String(i), 2, members, true)) }
  const sinks = new Map<string, (rec: any) => void>()
  const src = {
    ...stubSource(snaps),
    observe: (t: string, on: (rec: any) => void) => {
      sinks.set(t, on)
      // initial ring-buffer dump delivered synchronously on subscribe — pure history
      on({ key: [], value: { '0': { t: 1, kind: 'local', key: 'old1' }, '1': { t: 2, kind: 'local', key: 'old2' } } })
      return () => {}
    },
  }
  const b = await bridge({ source: src as any, port: 0, poll: 40 }) // 2 targets ⇒ grid mode ⇒ raw records relay
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => sinks.size === 2, 3000), 'push legs armed')
    sinks.get(members[0])!({ key: ['0'], value: { t: 3, kind: 'local', key: 'fresh' } }) // genuinely new
    sinks.get(members[0])!({ key: ['1'], value: { t: 2, kind: 'local', key: 'old2' } }) // replay of dumped history
    assert.ok(await until(() => sse.recs.some((r: any) => r.key === 'fresh'), 3000), 'the fresh event flowed')
    assert.equal(sse.recs.filter((r: any) => r.key === 'fresh').length, 1, 'exactly once')
    assert.ok(!sse.recs.some((r: any) => r.key === 'old1' || r.key === 'old2'), 'dump/replayed history never reaches the feed')
  } finally {
    sse.close()
    await b.close()
  }
})

test('push-leg revival: a socket bounce inside one poll is detected via observing:false and re-subscribed', async () => {
  const p = await ports.free()
  const S: any = await fero('obs-revive', { host: '127.0.0.1', port: p, ports: [p], wait: 100, observe: true })
  const src = networkSource({ seeds: [`127.0.0.1:${p}`], name: 'obs-revive' })
  const b = await bridge({ source: src, port: 0, poll: 80 })
  const sse = readSSE(b.port)
  try {
    assert.ok(await until(() => S[diagnostics].observing() === true, 5000), 'push leg armed')
    // ungraceful server-side drop of the bridge's connection — reaps the served sub (gate disarms),
    // while the bridge's dialed peer silently redials; without revival the push leg stays dead forever
    const peers = (S.cluster.peers as any)[value] ?? {}
    const addr = Object.keys(peers).find((a) => peers[a]?.role === 'client')
    assert.ok(addr, 'the bridge is a connected client peer on the server')
    S[diagnostics].drop(addr!)
    assert.ok(await until(() => S[diagnostics].observing() === false, 5000), 'server-side sub reaped')
    assert.ok(await until(() => S[diagnostics].observing() === true, 10000), 're-armed after the bounce (the revival)')
    S.data.alive = { v: 1 }
    assert.ok(await until(() => sse.recs.some((r: any) => r.key === 'alive'), 5000), 'provenance flows end-to-end again')
  } finally {
    sse.close()
    await b.close()
    S.destroy()
  }
})
