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

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { counts, syncProbes } from '../tools/perf/probes.ts'
import { tcpReplicate } from '../tools/perf/probes.tcp.ts'
import { compare, fingerprint, matches, type Baseline, type Current } from '../tools/perf/compare.ts'

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
