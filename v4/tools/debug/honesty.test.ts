//! ── tools/debug/honesty.test — THE promotion gate (plan §3.6, DESIGN-M7 §4) ──────────────────
// "A promotion-gate test renders an empty-but-valid capture and fails on any string not traceable to a
// folded fact." What is testable without a browser, stated plainly: the FOLD layer — the only place
// data-derived strings are minted — plus a source-level structural pin on the viewer's data plane.
// DOM template assembly (the viewer's own literals: labels, units, chrome) is the named residue,
// covered by review, not pretended away here.
//
// Every fixture below is REAL-PRODUCER (captureLive/captureSim of actual nodes) — never a hand-authored
// literal: v2's sample-coverage lock validated a fixture authored to match the fold, and the live feed
// drifted 5-of-6 tokens dead without the test noticing. A hand-built empty node would rot the same way.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Node } from '../../kernel/node.ts'
import { JK } from '../../kernel/journal.ts'
import { REC, type EffectSink, type Env } from '../../kernel/env.ts'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { shrink, sweepBuild } from '../../sim/shrink.ts'
import { captureLive, captureSim, captureAttached } from './capture.ts'
import {
  kindNames, stateAt, verifyReplay, routes, contested, summarize, cellKey,
  ROUTE_STATUS, ABSENT_REASONS,
} from './model.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

//! a constructed-but-never-stepped kernel Node: the emptiest REAL producer there is (kernel purity
// means a constructor emits nothing — no journal rows, no state, no logs, no links)
const bareNode = () => {
  const sink = {
    connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {},
    confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {},
  } as unknown as EffectSink
  const env: Env = { now: () => 0, rng: () => 0, sink }
  return new Node({ uuid: 'gate' }, env)
}

test('(a) fold closure on EMPTY real-producer captures: exhaustive goldens, nothing synthesized', () => {
  const A0 = captureLive([])
  //! deep-equal on the WHOLE object — any field a fold learns to invent breaks this immediately
  assert.deepEqual(summarize(A0), {
    kind: 'live', seed: null, nodes: 0, events: null, quiesced: null, violations: [],
    journalRows: 0, truncated: [], converged: null, absent: [], shrunk: null,
  })
  assert.equal((routes(A0) as Map<string, unknown>).size, 0)
  assert.deepEqual(contested(A0), [])
  assert.deepEqual(verifyReplay(A0), [])

  const A1 = captureLive([bareNode()])
  assert.equal((stateAt(A1, 'gate', Infinity) as Map<string, unknown>).size, 0, 'no state at any t')
  assert.deepEqual(verifyReplay(A1), [{ uuid: 'gate', ok: true }], 'an empty node replays trivially — and says so')
  assert.equal((routes(A1) as Map<string, unknown>).size, 0)
  assert.deepEqual(contested(A1), [])
  const s1 = summarize(A1) as { nodes: number; converged: boolean; journalRows: number }
  assert.equal(s1.nodes, 1)
  assert.equal(s1.journalRows, 0)
  assert.equal(s1.converged, true, 'one node trivially agrees with itself — a FACT about a real node')
  //! the vocabulary inverts completely: every rendered kind name traces to the capture's own vocab
  const names = kindNames(A1) as Record<number, string>
  assert.equal(Object.keys(names).length, Object.keys(JK).length)
  for (const [name, code] of Object.entries(JK)) assert.equal(names[code as number], name)
})

//! collect every string leaf a fold emitted (Maps/arrays/objects walked; keys are structure, not data)
const leaves = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) leaves(x, out)
  else if (v instanceof Map) for (const [k, x] of v) { leaves(k, out); leaves(x, out) }
  else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out)
  return out
}
//! every string ANYWHERE in the source capture — the traceability universe
const capStrings = (c: unknown): Set<string> => new Set(leaves(c).concat(Object.keys(JK)))

//! every NUMBER in the capture, stringified: a fold may render a captured scalar as text (a seq, a
// partition id) — that is derivation, not invention
const capNumbers = (v: unknown, out: Set<string> = new Set()): Set<string> => {
  if (typeof v === 'number') out.add(String(v))
  else if (Array.isArray(v)) for (const x of v) capNumbers(x, out)
  else if (v instanceof Map) for (const [k, x] of v) { capNumbers(k, out); capNumbers(x, out) }
  else if (v && typeof v === 'object') for (const x of Object.values(v)) capNumbers(x, out)
  return out
}

//! traces — a fold-emitted string is honest iff it IS a capture string/closed-enum member, or a
// COMPOSITE IDENTITY whose every part is one (routes keys are `origin#seq`, cellKey is a JSON array of
// key parts). The gate verifies the derivation instead of blanket-allowing a shape — an invented word
// inside a composite still fails.
const traces = (s: string, allowed: Set<string>, nums: Set<string>): boolean => {
  if (allowed.has(s) || nums.has(s)) return true
  const parts = s.split('#')
  return parts.length > 1 && parts.every((p) => allowed.has(p) || nums.has(p))
}

test('(b) string-leaf traceability: every fold-emitted string traces to a capture fact or a CLOSED enum', () => {
  //! three real fixtures: a chaotic sim run, a shrunk capture (the M7 strings), an attached capture with
  // an absent row — so the carve-out and the new fields are all exercised, never dormant
  const sim = new Sim(1337)
  const nodes = cluster(sim, 3)
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 15], dupP: 0.3 })
  writes(sim, nodes, 40, 300)
  sim.at(60, () => sim.partition('n01', 'n03'))
  sim.at(200, () => sim.heal('n01', 'n03'))
  sim.run()
  const chaotic = captureSim(sim)
  const attached = captureAttached([], [{ target: '127.0.0.1:1', reason: 'timeout' }])

  const universe = (c: unknown) =>
    new Set([...capStrings(c), ...ROUTE_STATUS, ...ABSENT_REASONS, ...Object.keys(JK)])

  for (const cap of [chaotic, attached, captureLive([bareNode()])]) {
    const allowed = universe(cap)
    const nums = capNumbers(cap)
    //! cell keys are JSON encodings of capture keys — derived, so add them to the universe explicitly
    for (const n of cap.nodes)
      for (const [, entries] of Object.entries(n.logs))
        for (const e of entries as { k: string[]; at?: string }[]) allowed.add(cellKey(e.k, e.at))
    for (const [name, fold] of [
      ['summarize', summarize], ['routes', routes], ['contested', contested], ['kindNames', kindNames],
    ] as const) {
      for (const s of leaves(fold(cap)))
        assert.ok(traces(s, allowed, nums), `${name} minted an untraceable string: ${JSON.stringify(s)}`)
    }
    //! verifyReplay is the ONE prose-minting fold — carved out and pinned by TEMPLATE instead
    for (const r of verifyReplay(cap) as { ok: boolean; uuid: string; reason?: string }[]) {
      if (r.ok) continue
      assert.ok(
        /^journal truncated \(\d+ dropped\)$/.test(r.reason!) ||
        /^size \d+ vs \d+$/.test(r.reason!) ||
        /^replay has .+, capture does not$/.test(r.reason!) ||
        /^.+: .+ vs .+$/.test(r.reason!),
        `verifyReplay prose outside its pinned templates: ${JSON.stringify(r.reason)}`,
      )
    }
  }
})

test('(b2) the prose carve-out is EXERCISED, not dormant: a truncated capture mints its pinned template', () => {
  //! a real node with a 4-row ring, overflowed — truncation is a fact the fold must SAY, loudly
  const sink = {
    connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {},
    confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {},
  } as unknown as EffectSink
  const n = new Node({ uuid: 'trunc', journalCap: 4 }, { now: () => 0, rng: () => 0, sink })
  n.step({ kind: 'start' })
  for (let i = 0; i < 12; i++) n.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  const cap = captureLive([n])
  const [r] = verifyReplay(cap) as { ok: boolean; reason: string }[]
  assert.equal(r.ok, false, 'truncation DISABLES the replay claim rather than reconstructing fiction')
  assert.match(r.reason, /^journal truncated \(\d+ dropped\)$/)
})

test('(c) absent honesty: an absent row changes summarize verbatim and NOTHING else', () => {
  const sim = new Sim(7)
  const nodes = cluster(sim, 2)
  writes(sim, nodes, 12, 100)
  sim.run()
  const base = { ...captureSim(sim), kind: 'live' as const, absent: [] as { target: string; reason: string }[] }
  const withAbsent = { ...base, absent: [{ target: 'x:1', reason: 'timeout' as const }] }
  assert.deepEqual(summarize(withAbsent).absent, [{ target: 'x:1', reason: 'timeout' }], 'carried verbatim')
  const strip = (s: Record<string, unknown>) => { const { absent: _, ...rest } = s; return rest }
  assert.deepEqual(strip(summarize(withAbsent)), strip(summarize(base)), 'no other header fact moves')
  assert.deepEqual([...(routes(withAbsent) as Map<string, unknown>)], [...(routes(base) as Map<string, unknown>)])
  assert.deepEqual(verifyReplay(withAbsent), verifyReplay(base))
  assert.deepEqual(contested(withAbsent), contested(base))
})

test('(c2) shrunk facts are passthrough only: the viewer can never infer shrunk-ness', () => {
  //! a REAL shrunk capture (the mutation is the acceptance demo's; here we only need the fields)
  const s = shrink(sweepBuild(1))
  const plain = captureSim(new Sim(0)) // no shrunk block
  assert.equal(summarize(plain).shrunk, null, 'absent ⇒ null, never a default-shaped object')
  if (s) {
    const cap = captureSim(s.sim, s)
    assert.deepEqual(summarize(cap).shrunk, cap.shrunk, 'present ⇒ verbatim passthrough')
  }
})

test('(d) the viewer data plane: exactly one model import, no local fold redefinitions', () => {
  const src = readFileSync(join(HERE, 'viewer.html'), 'utf8')
  const imports = [...src.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+'([^']+)'/gm)]
  assert.equal(imports.length, 1, 'the viewer has exactly ONE module import — the model')
  assert.equal(imports[0][2], './model.mjs')
  const imported = imports[0][1].split(',').map((s) => s.trim()).sort()
  assert.deepEqual(imported, ['cellKey', 'contested', 'decodeVal', 'kindNames', 'routes', 'stateAt', 'summarize', 'verifyReplay'])
  //! no local shadowing: a fold reimplemented in the page is exactly v2's dual-language drift bug
  for (const name of imported)
    assert.ok(
      !new RegExp(`(function|const|let|var)\\s+${name}\\b`).test(src),
      `viewer.html redefines ${name} locally — the model must be the ONE fold source`,
    )
})
