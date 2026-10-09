//! ── tests/baseline.perf — the absolute-tier gate (runs inside `npm run perf`, never npm test) ────
// Three tests, three postures (BASELINE.md is the reading guide):
//   counts — wire-structural laws, exact-compared on ANY machine; a missing tracked baseline is a
//            DELETION, not an excuse (hard fail with the restore/re-pin pointer).
//   wall   — fingerprint match + advisory ⇒ printed deltas; match + pinned ⇒ enforced tolerance;
//            mismatch ⇒ t.skip — the honest third state (a sanctioned skip site: environment
//            honesty, not a defect — see the green-or-quarantined policy in the README).
//   tier-3 — the socket throughput probe: validity is part of the probe (journal-tap shed guard,
//            onApply counter, convergence); an invalid run is a PROBE-ERROR skip with the reason,
//            never a fake number in either direction.
// Plus the relay pin (below the counts): a counted law and a wall tripwire of its own, not baseline rows.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { counts, syncProbes } from '../tools/perf/probes.ts'
import { tcpReplicate } from '../tools/perf/probes.tcp.ts'
import { compare, fingerprint, matches, type Baseline, type Current } from '../tools/perf/compare.ts'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from '../api/data.ts'
import { Framer, VERB, encodeControl, encodeRuns } from '../kernel/codec.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { bench } from '#utils'

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'perf', 'results', 'baseline.json')

const load = (): Baseline => {
  assert.ok(existsSync(BASELINE), 'tracked baseline missing — restore tools/perf/results/baseline.json or re-pin per BASELINE.md (absence of a tracked file is deletion, not a fresh start)')
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline
}

test('counts: the wire-structural laws match the tracked baseline exactly (any machine)', () => {
  const b = load()
  const cur = counts()
  for (const [key, want] of Object.entries(b.counts))
    assert.equal(cur[key], want, `COUNT DRIFT ${key}: baseline ${want}, current ${cur[key]} — a wire law moved (DECISIONS + re-pin, or a regression)`)
  for (const key of Object.keys(cur))
    assert.ok(key in b.counts, `unpinned count ${key} — re-pin to adopt it`)
})

//! ── the relay pin (2026-10-09): one client, N relayed updates through one open server ──────────────
// Since V4-28 every open server hands the kernel's relay ingress (kernel/write.ts onWrite) a check:
// `(rec) => bind.admit(rec)` — the embedder's validation:, then the sparse-hole test. Nothing pinned that
// path. These two tests are it: a counted law (exact on ANY machine, so CI's `^counts:` run takes it)
// and a wall tripwire with the per-file headroom the siblings use (WSL2 swings 2-3x). Both are self-
// contained — not rows of baseline.json, which only the perf:pin CLI writes.
//! what each one sees: the COUNTED law pins the check itself (exactly one call per relayed record; a
// doubled check goes red at 1024). The WALL tripwire times the whole relay path (relay, check, commit,
// apply), not the check: the check costs a few ns of a record's ~15-40 µs here, so a slower check trips
// the wall only once it adds about 100 µs a record (the review made bind.admit busy-wait 50 µs per call:
// 39.9 ms / 512, still green). The wall guards the path from a gross regression, nothing finer.
// The server is a solo open server (no member link, so it stays at epoch 0 and owns everything: the
// relay commits at once). The client is one accepted link that said HELLO r:1 and an r:1 DIGEST, so
// it also takes the server's commit stream. The check is the composer's own closure (api/index.ts).
const RELAY_N = 512 // one wire run, under MAX_PENDING (1024): every relayed record is queued, none dropped
const relayServer = (onCheck?: () => void) => {
  let bind!: Bind
  const rt = new Runtime({
    uuid: 'aa', heartbeatMs: 0,
    validate: onCheck ? (rec: Rec) => { onCheck(); return bind.admit(rec) } : (rec: Rec) => bind.admit(rec),
  })
  bind = new Bind(rt)
  const node = rt.node
  node.journal.armed = false // perf posture: an unwatched journal costs nothing
  const out: { link: number; verb: number; v: unknown }[] = []
  node.env.sink.send = (link: number, bytes: Uint8Array) => {
    if (onCheck) for (const f of new Framer().push(bytes.slice())) out.push({ link, verb: f.verb, v: f.verb === VERB.WACK ? f.value : null })
  }
  node.step({ kind: 'linkUp', link: 2, dialed: false })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1 }) })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  return { rt, bind, node, out }
}
//! pre-encoded client WRITE runs (ae 0, the client marker), ADVANCING cids and fresh values: no rep
// ever hits the relay's dedup skip or a no-op apply. One run per frame.
const relayFrames = (count: number): Uint8Array[] => {
  const frames: Uint8Array[] = []
  let cid = 0
  for (let f = 0; f < count; f++) {
    const recs = Array.from({ length: RELAY_N }, (_, i) => ({
      rec: { type: REC.update, key: ['r' + (i & 255), 'f'], value: { n: cid + 1, s: `v${i}` } } as Rec,
      origin: 'zz~1', seq: ++cid, epoch: 0,
    }))
    const [frame, ...rest] = encodeRuns(recs, VERB.WRITE)
    assert.equal(rest.length, 0, 'fixture: one run per frame')
    frames.push(frame)
  }
  return frames
}

test('counts: relay — one client run of 512 updates through an open server: 512 checks, 512 commits, 1 WACK + 1 stream frame', async () => {
  let checks = 0
  const s = relayServer(() => { checks++ })
  const seq0 = s.node.seq
  s.out.length = 0
  s.node.step({ kind: 'bytesIn', link: 2, bytes: relayFrames(1)[0] })
  assert.equal(checks, RELAY_N, 'the relay check ran once per relayed record (V4-28: an open server always checks)')
  assert.equal(s.node.seq - seq0, RELAY_N, 'every relayed record committed once')
  assert.equal(s.node.writes.pending.size, 0, 'nothing left queued at the relay')
  assert.deepEqual(s.out.map((o) => [o.link, o.verb]), [[2, VERB.RECORDS], [2, VERB.WACK]], 'one run in = one stream frame + one WACK out, both to the client')
  const ack = s.out[1].v as { u: string; c: number; n: number }
  assert.deepEqual([ack.u, ack.c, ack.n], ['zz~1', 1, RELAY_N], 'one WACK covers the whole run')
  s.bind.destroy()
  await s.rt.destroy()
})

test('wall: relay — 512 client updates per rep through an open server\'s relay, check, commit and apply under the tripwire', async () => {
  const s = relayServer()
  const frames = relayFrames(6)
  let i = 0
  const ms = bench.time(() => { s.node.step({ kind: 'bytesIn', link: 2, bytes: frames[i++] }) })
  assert.equal(s.node.seq, RELAY_N * 6, 'all six reps (warmup + 5) relayed and committed for real')
  console.log(`  relay on this runner: ~${Math.round(RELAY_N / (ms / 1000)).toLocaleString()} relayed records/s through one open server (${ms.toFixed(2)}ms / ${RELAY_N})`)
  assert.ok(ms < 80, `512 relayed updates took ${ms.toFixed(1)}ms (tripwire 80ms)`)
  s.bind.destroy()
  await s.rt.destroy()
})

test('wall: sync-probe medians vs the baseline — advisory prints, pinned enforces, mismatch skips honestly', async (t) => {
  const b = load()
  const f = fingerprint()
  if (!matches(b, f)) {
    t.skip(`no baseline for this runner — '${b.runner.id}' pinned on ${b.runner.host} / ${b.runner.cpu} / node ${b.runner.node}; cross-machine ms comparison is meaningless (BASELINE.md)`)
    return
  }
  const cur: Current = { counts: {}, probes: {} }
  for (const p of syncProbes) {
    try { cur.probes[p.id] = await p.run() }
    catch (e) { cur.probes[p.id] = { error: e instanceof Error ? e.message : String(e) } }
  }
  const verdicts = compare({ ...b, counts: {} }, cur, f)
  for (const v of verdicts) {
    if (v.kind === 'probe-error') assert.fail(`probe ${v.id} invalid in-process (no sockets here — this is a real bug): ${v.error}`)
    else if (v.kind === 'ms-delta') {
      const line = `${v.id}: ${v.baseMs}ms → ${v.curMs}ms (+${v.pct}%)`
      if (v.enforce) assert.fail(`REGRESSION past pinned tolerance — ${line} (never widen: BASELINE.md)`)
      else console.log(`  advisory: slower ${line}`)
    } else if (v.kind === 'improved') console.log(`  advisory: improved ${v.id} ${v.pct}% — re-pin candidate`)
  }
})

test('tier-3 socket throughput: a valid measured number or a typed probe-error — never a fake', async (t) => {
  const b = load()
  const f = fingerprint()
  const r = await tcpReplicate()
  if (r.error) {
    //! sanctioned skip: transient socket-environment invalidity, self-declared by the probe's guards
    t.skip(`probe invalid on this run (${r.error}) — the ms comparison has no operand; the counted invariants that make the number trustworthy are the same ones that just refused it`)
    return
  }
  console.log(`  tcp.replicate-20k: ${r.ms}ms/rep · ~${r.persec.toLocaleString()} records/s through the real shell`)
  if (matches(b, f)) {
    const row = b.probes['tcp.replicate-20k']
    if (row && row.ms > 0) {
      const pct = +(((r.ms - row.ms) / row.ms) * 100).toFixed(1)
      if (b.runner.posture === 'pinned' && pct > b.msTolerancePct)
        assert.fail(`REGRESSION past pinned tolerance — tcp.replicate-20k ${row.ms}ms → ${r.ms}ms (+${pct}%)`)
      else if (Math.abs(pct) > b.msTolerancePct) console.log(`  advisory: ${pct > 0 ? 'slower' : 'improved'} ${pct}% vs baseline`)
    }
  }
})
