//! ── tools/perf/absolute.test — the machinery's own truth table (pure; runs in npm test) ─────────
// The comparison policy, the pin refusals, the fixture single-sourcing pin, and the TRACKED
// baseline's validity — including the msTolerancePct cap that keeps tolerance from becoming a
// never-widen bypass. No probes run here (npm test stays fast and socket-free); the runtime gate
// lives in tests/baseline.perf.ts inside `npm run perf`.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, matches, pinRefusal, type Baseline, type Current, type Fingerprint } from './compare.ts'
import { CANONICAL_FRAME_BYTES, canonicalFrame } from './fixtures.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const base = (over: Partial<Baseline> = {}, runner: Partial<Baseline['runner']> = {}): Baseline => ({
  schema: 1, kind: 'fero-v3-absolute-baseline', rev: 'abc1234', when: '2026-07-28T00:00:00Z',
  dirty: false, reason: 'test', supersedes: null,
  runner: { id: 'box', posture: 'advisory', host: 'h', os: 'Linux', release: '6.0', cpu: 'X ×8', node: '26.1.0', ...runner },
  msTolerancePct: 50,
  counts: { 'wire.bytes-per-record': 73 },
  probes: { 'codec.encode-decode-10k': { file: 'kernel/codec.perf.ts', ms: 100, n: 10000, persec: 100000 } },
  ...over,
})
const HERE_F: Fingerprint = { host: 'h', os: 'Linux', cpu: 'X ×8', nodeMajor: '26' }
const OTHER_F: Fingerprint = { host: 'elsewhere', os: 'Linux', cpu: 'Y ×4', nodeMajor: '26' }

test('compare truth table: counts hard on any machine; ms only on the matching runner; posture decides enforcement', () => {
  //! count drift fails EVERYWHERE — even on a non-matching runner
  const drift = compare(base(), { counts: { 'wire.bytes-per-record': 74 }, probes: {} }, OTHER_F)
  assert.ok(drift.some((v) => v.kind === 'count-drift'), 'count drift must surface cross-runner')
  //! runner mismatch: ms never compared, the honest third state surfaces
  const mm = compare(base(), { counts: { 'wire.bytes-per-record': 73 }, probes: { 'codec.encode-decode-10k': { ms: 500 } } }, OTHER_F)
  assert.ok(mm.some((v) => v.kind === 'no-runner-match'))
  assert.ok(!mm.some((v) => v.kind === 'ms-delta'), 'cross-machine ms comparison is meaningless')
  //! advisory 5x slower: reported, never enforced
  const adv = compare(base(), { counts: { 'wire.bytes-per-record': 73 }, probes: { 'codec.encode-decode-10k': { ms: 500 } } }, HERE_F)
  const d = adv.find((v) => v.kind === 'ms-delta')
  assert.ok(d && d.kind === 'ms-delta' && d.enforce === false, 'advisory posture never enforces')
  //! pinned 1.6x-of-tolerance: enforced
  const pin = compare(base({}, { posture: 'pinned' }), { counts: { 'wire.bytes-per-record': 73 }, probes: { 'codec.encode-decode-10k': { ms: 180 } } }, HERE_F)
  const e = pin.find((v) => v.kind === 'ms-delta')
  assert.ok(e && e.kind === 'ms-delta' && e.enforce === true, 'pinned posture enforces past tolerance')
  //! an improvement past tolerance is a re-pin candidate, never a failure
  const imp = compare(base({}, { posture: 'pinned' }), { counts: { 'wire.bytes-per-record': 73 }, probes: { 'codec.encode-decode-10k': { ms: 20 } } }, HERE_F)
  assert.ok(imp.some((v) => v.kind === 'improved') && !imp.some((v) => v.kind === 'ms-delta'))
  //! probe errors surface regardless of runner
  const pe = compare(base(), { counts: { 'wire.bytes-per-record': 73 }, probes: { 'codec.encode-decode-10k': { error: 'boom' } } }, OTHER_F)
  assert.ok(pe.some((v) => v.kind === 'probe-error'))
  //! an unknown schema skips BOTH tiers loudly — never guesses
  const unk = compare(base({ schema: 2 }), { counts: { 'wire.bytes-per-record': 74 }, probes: {} }, HERE_F)
  assert.deepEqual(unk.map((v) => v.kind), ['schema-unknown'])
  //! node MAJOR matches, full version doesn't have to
  assert.ok(matches(base({}, { node: '26.9.9' }), HERE_F))
  assert.ok(!matches(base({}, { node: '25.0.0' }), HERE_F))
})

test('pin refusals: runner + reason required; --pinned refused on WSL/VM; invalid tier-3 unpinnable; tolerance capped', () => {
  const ok = { runner: 'box', reason: 'initial', pinned: false, release: '6.6.0-generic', msTolerancePct: 50 }
  assert.equal(pinRefusal(ok), null)
  assert.match(pinRefusal({ ...ok, runner: undefined })!, /--runner/)
  assert.match(pinRefusal({ ...ok, reason: undefined })!, /--reason/)
  assert.match(pinRefusal({ ...ok, pinned: true, release: '6.18.33.2-microsoft-standard-WSL2' })!, /refused on/)
  assert.equal(pinRefusal({ ...ok, pinned: false, release: '6.18.33.2-microsoft-standard-WSL2' }), null, 'advisory pins are legal on WSL')
  assert.match(pinRefusal({ ...ok, tier3Error: 'formation timeout' })!, /does not exist/)
  assert.match(pinRefusal({ ...ok, msTolerancePct: 500 })!, /never-widen bypass/)
  assert.match(pinRefusal({ ...ok, msTolerancePct: 5 })!, /never-widen bypass/)
})

test('fixture single-sourcing: the canonical frame IS the pinned constant (one source, two consumers)', () => {
  assert.equal(canonicalFrame().length, CANONICAL_FRAME_BYTES)
  assert.equal(CANONICAL_FRAME_BYTES, 73)
})

test('the TRACKED baseline is valid: schema, runner identity, honest posture, bounded tolerance', () => {
  const b = JSON.parse(readFileSync(join(HERE, 'results', 'baseline.json'), 'utf8')) as Baseline
  assert.equal(b.schema, 1)
  assert.equal(b.kind, 'fero-v3-absolute-baseline')
  assert.ok(b.reason.length > 0, 'a baseline must say why it was pinned')
  for (const k of ['id', 'posture', 'host', 'os', 'release', 'cpu', 'node'] as const)
    assert.ok(typeof b.runner[k] === 'string' && b.runner[k].length > 0, `runner.${k} missing`)
  assert.ok(b.runner.posture === 'advisory' || b.runner.posture === 'pinned')
  //! the cap that closes the tolerance bypass: outside [10, 50] the machinery's own test goes red
  assert.ok(b.msTolerancePct >= 10 && b.msTolerancePct <= 50, `msTolerancePct ${b.msTolerancePct} outside [10, 50]`)
  //! a WSL/VM box may never carry the pinned posture (the CLI refuses; this pins the artifact too)
  if (/microsoft|wsl|virtual|vbox|vmware|hyper-v/i.test(b.runner.release))
    assert.equal(b.runner.posture, 'advisory', 'a WSL/VM-recorded baseline must be advisory')
  assert.equal(b.counts['wire.bytes-per-record'], CANONICAL_FRAME_BYTES, 'the persisted wire law must match the fixture constant')
})
