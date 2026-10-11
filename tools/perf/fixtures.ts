//! ── tools/perf/fixtures — ONE source for the shapes the perf siblings AND the baseline probes share ──
// The M8 baseline machinery re-runs the siblings' loop shapes to persist their medians (probes.ts) and
// recomputes the wire-count laws the baseline exact-compares. Hand-copying those fixtures into a second
// file is precisely the two-copies-drift the never-widen rule exists to prevent — so the declarations
// live HERE and both consumers import them. RULE for this file: pure declarations only; every timed
// LOOP BODY stays in its owning file, byte-identical to its pre-extraction form (the extraction is
// proved perturbation-free by a back-to-back `npm run perf` A/B — see DESIGN-M8 in DECISIONS).

import { Node } from '../../kernel/node.ts'
import { Ring } from '../../kernel/ring.ts'
import { VERB, encodeControl, encodeFrame, encodeRuns } from '../../kernel/codec.ts'
import { REC, type Env, type Rec } from '../../kernel/env.ts'

//! the canonical record's exact bytes-on-wire — codec.perf.ts asserts it, the baseline persists it;
// a wire change moves BOTH from this one constant (and must justify itself in DECISIONS)
export const CANONICAL_FRAME_BYTES = 73
export const canonicalFrame = (): Uint8Array =>
  encodeFrame(
    [{ type: REC.update, key: ['key1', 'field'], value: { n: 1, s: 'value-1', ok: true } }],
    { origin: 'origin-1', baseSeq: 1, epoch: 0 },
  )

//! codec.perf's 10k-record workload, verbatim
export const CODEC_N = 10_000
export const codecRecs: Rec[] = Array.from({ length: CODEC_N }, (_, i) => ({
  type: REC.update,
  key: [`key${i % 512}`, 'field'],
  value: { n: i, s: `value-${i}`, ok: (i & 1) === 0 },
}))

//! node.perf's 2k-record batch, verbatim
export const NODE_BATCH = 2_000
export const nodeRecs: Rec[] = Array.from({ length: NODE_BATCH }, (_, i) => ({
  type: REC.update, key: [`k${i % 256}`], value: { n: i, s: `v${i}` },
}))

//! a formed synced 1-peer node with a swallow-everything sink — measures kernel work, not I/O (node.perf.ts)
export const formedNode = (): Node => {
  const env: Env = {
    now: () => 0,
    rng: () => 0.5,
    sink: { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.journal.armed = false // perf posture: unwatched journal must cost ~nothing (predicted-false emit gates)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) }) // sync — live records flow
  return node
}

//! a formed 3-member view-1 node — aa is the lowest uuid, so it self-proposes genesis on the first tick (write.perf.ts)
export const formedView1 = (opts: { swallowTimers?: boolean } = {}) => {
  let frames = 0
  const timers: { id: number; tag: number }[] = []
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: {
      connect() {}, send() { frames++ }, close() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {},
      timer(id, tag) { if (!opts.swallowTimers) timers.push({ id, tag }) },
    },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1', hosts: ['x:2', 'x:3'], heartbeatMs: 50 }, env)
  node.journal.armed = false // perf posture: unwatched journal must cost ~nothing
  node.step({ kind: 'start' })
  for (let p = 0; p < 2; p++) {
    const u = p === 0 ? 'bb' : 'cc'
    node.step({ kind: 'linkUp', link: p + 1, dialed: true, to: `x:${p + 2}` })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `x:${p + 2}` }) })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  const hb = timers.find((t) => t.tag === 2)!
  node.step({ kind: 'timer', id: hb.id, tag: hb.tag }) // genesis tick → propose view 1
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  if (node.epoch !== 1) throw new Error('perf fixture failed to commit view 1')
  return { node, framesSent: () => frames }
}

//! the OWNER leg fixture: pre-encoded WRITE frames from one issuer, contiguous cids, all self-owned (write.perf.ts)
export const writeFrames = (count: number, batch: number): Uint8Array[] => {
  const frames: Uint8Array[] = []
  for (let f = 0; f < count; f++) {
    const recs = Array.from({ length: batch }, (_, i) => ({
      rec: { type: REC.update, key: [`hot`, `f${(f * batch + i) % 512}`], value: { n: i, s: `v${i}` } } as Rec,
      origin: 'bb~1', seq: 1 + f * batch + i, epoch: 1,
    }))
    frames.push(...encodeRuns(recs, VERB.WRITE))
  }
  return frames
}

//! the 5-member ring + 4096-partition keyspace (ring.perf.ts / alloc.perf.ts)
export const ringFixture = (): Ring => {
  const r = new Ring()
  r.build(1, Array.from({ length: 5 }, (_, i) => [`n${String(i + 1).padStart(2, '0')}`, `sim:${i}`] as [string, string]))
  return r
}
export const ringKeys = Array.from({ length: 4096 }, (_, i) => `part${i}`)

//! the TORN-SHIP fixture (the resume-cost fix, 2026-10-11 — kernel/node.perf.ts and kernel/client.test.ts): a feeder
// holding `n` sparse records of lane `bb` (every other seq, so one frame per record — the shape of a held-filtered
// scoped lane), and a client on link 7 whose socket behaves like the shell's: a send that leaves more than `hwm` bytes
// buffered steps `pause` from INSIDE the send, and drain() empties the buffer and steps `drain`. ask() sends the
// client's first-connect digest (d = {}, r = 1). The counters: `handed` = frames handed to the link's send gate (each
// one encoded once — the answer encodes a frame only to hand it over), `sent` = frames that reached the socket,
// `last` = the last frame's bytes. The timed loop stays in its owning file.
export const tornFeeder = (n: number, hwm: number, queued?: number) => {
  const c = { buffered: 0, paused: false, handed: 0, sent: 0, last: null as Uint8Array | null }
  let node: Node
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: {
      connect() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {},
      send(link, bytes) {
        if (link !== 7) return
        c.sent++; c.last = bytes; c.buffered += bytes.length
        if (!c.paused && c.buffered > hwm) { c.paused = true; node.step({ kind: 'pause', link: 7 }) }
      },
    },
  }
  node = new Node({ uuid: 'ff', listen: 'x:1', heartbeatMs: 50, ...(queued !== undefined ? { tune: { queued } } : {}) }, env)
  node.journal.armed = false
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  for (let at = 0; at < n; at += 4096) {
    const frames = encodeRuns(Array.from({ length: Math.min(4096, n - at) }, (_, k) => {
      const i = at + k
      return { rec: { type: REC.update, key: [`r${i}`], value: i } as Rec, origin: 'bb', seq: 2 * i + 1, epoch: 1 }
    }))
    const chunk = new Uint8Array(frames.reduce((s, f) => s + f.length, 0))
    let o = 0
    for (const f of frames) { chunk.set(f, o); o += f.length }
    node.step({ kind: 'bytesIn', link: 1, bytes: chunk })
  }
  node.step({ kind: 'linkUp', link: 7, dialed: false })
  node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'x:9', r: 1 }) })
  const link = node.links.get(7)!
  const ship = link.ship.bind(link)
  link.ship = (bytes, sink, j) => { c.handed++; ship(bytes, sink, j) }
  c.sent = 0; c.buffered = 0 // the HELLO went out at admit; count from the ask
  const ask = encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 })
  return {
    node, link, c,
    ask: () => node.step({ kind: 'bytesIn', link: 7, bytes: ask }),
    drain: () => { c.buffered = 0; c.paused = false; node.step({ kind: 'drain', link: 7 }) },
  }
}
