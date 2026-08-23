//! Tier: debug-DOM harness for scenarios.html — the validation harness the module header promises:
// extract the whole inline module, evaluate it in node:vm WITHOUT a document (the typeof-document
// guard keeps DOM wiring inert), and drive esc/rel/fmtDelta/diagram/cardHTML/tallyHTML directly on
// contract-shaped payloads. Deliberately runAll()-free: the registry's data contract is
// scenarios.test.ts's job (and viewer.dom.test.ts already pays runAll twice per suite) — THIS file
// pins the renderer's laws, including the schematic shapes the scale cards lean on.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('./scenarios.html', import.meta.url), 'utf8')
const src = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1]
assert.ok(src, 'scenarios.html holds one inline module script')

const ctx = vm.createContext({})
//! const/let bindings stay script-scoped, so the export hook rides the SAME evaluation
vm.runInContext(`${src}\n;this.__H__ = { esc, rel, fmtDelta, diagram, cardHTML, tallyHTML }`, ctx, { filename: 'scenarios.html#module' })
const H = (ctx as { __H__: Record<string, (...a: never[]) => string> }).__H__
const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${String(i + 1).padStart(Math.max(2, String(n).length), '0')}`)
const count = (s: string, needle: string) => s.split(needle).length - 1

test('the module is extractable and inert without a document — every pure helper defined, no DOM touched', () => {
  for (const k of ['esc', 'rel', 'fmtDelta', 'diagram', 'cardHTML', 'tallyHTML'])
    assert.equal(typeof H[k], 'function', `${k} extracted`)
})

test('esc neutralizes every server-derived string before it reaches innerHTML', () => {
  const out = (H.esc as (s: unknown) => string)(`<img src=x onerror="pwn('&')">`)
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('"') && !out.includes("'"), out)
  assert.equal(out, '&lt;img src=x onerror=&quot;pwn(&#39;&amp;&#39;)&quot;&gt;')
})

test('rel buckets: just now / s / m / h / plain date past 24h; garbage renders as absence', () => {
  const rel = H.rel as (iso: string, now?: number) => string
  const t0 = Date.parse('2026-08-23T12:00:00Z')
  assert.equal(rel('2026-08-23T11:59:57Z', t0), 'just now')
  assert.equal(rel('2026-08-23T11:59:18Z', t0), '42s ago')
  assert.equal(rel('2026-08-23T11:48:00Z', t0), '12m ago')
  assert.equal(rel('2026-08-23T09:00:00Z', t0), '3h ago')
  assert.equal(rel('2026-08-20T12:00:00Z', t0), '2026-08-20')
  assert.equal(rel('not-a-date', t0), '')
})

test('fmtDelta: counts are always-signal (quiet = / warn chip), ms is dim ±% (hot past +100), no base renders as absence', () => {
  const d = H.fmtDelta as (m: { k: string; v: number | string; kind: string }, base: Record<string, number | string> | null) => string
  assert.equal(d({ k: 'events', v: 5, kind: 'count' }, { events: 5 }), '<span class="deq">=</span>')
  assert.ok(d({ k: 'events', v: 6, kind: 'count' }, { events: 5 }).includes('5 → 6'), 'count drift chips old → new')
  assert.ok(!d({ k: 'events', v: 4, kind: 'count' }, { events: 5 }).includes('deq'), 'a count IMPROVEMENT still chips — drift is never green')
  assert.equal(d({ k: 'wall ms', v: 30, kind: 'ms' }, { 'wall ms': 20 }), `<span class="dms" title="wall-clock is noisy on this machine — counted rows are the signal">+50%</span>`)
  assert.ok(d({ k: 'wall ms', v: 50, kind: 'ms' }, { 'wall ms': 20 }).includes('dms hot'), '+150% goes hot')
  assert.equal(d({ k: 'seeds', v: '100/100', kind: 'text' }, { seeds: '100/100' }), '', 'equal text renders nothing')
  assert.equal(d({ k: 'events', v: 5, kind: 'count' }, null), '', 'no base → empty cell')
  assert.equal(d({ k: 'events', v: 5, kind: 'count' }, { other: 5 }), '', 'no base ENTRY → empty cell')
})

test('diagram: a mesh schematic is exactly all-pairs — the scale cards depend on these counts', () => {
  const dg = H.diagram as (d: unknown) => string
  //! the three scale-card schematics, pinned: n nodes on a ring, n(n-1)/2 hairlines
  for (const [n, lines] of [[10, 45], [8, 28], [6, 15]] as const) {
    const svg = dg({ nodes: ids(n), mesh: true, phases: [{ label: 'a', sev: 'ok' }, { label: 'b', sev: 'info' }, { label: 'c', sev: 'gold' }] })
    assert.equal(count(svg, '<line'), lines, `n=${n}: ${lines} mesh lines`)
    assert.equal(count(svg, 'class="nc"'), n, `n=${n}: one node circle each`)
    assert.ok(svg.includes(`topology: ${n} nodes`), 'aria-label states the width')
  }
})

test('diagram: writers badge, fault ≋ / cut ✂ glyphs, cut-over-fault stroke precedence, unknown ids skipped', () => {
  const dg = H.diagram as (d: unknown) => string
  const svg = dg({
    nodes: ids(4), mesh: true, writers: [ids(4)[0], 'ghost'],
    faults: [[ids(4)[0], ids(4)[1]], [ids(4)[1], ids(4)[2]]],
    cut: [[ids(4)[0], ids(4)[1]], ['ghost', ids(4)[2]]],
    phases: [{ label: 'x', sev: 'ok' }, { label: 'y', sev: 'crit' }, { label: 'z', sev: 'warn' }],
  })
  assert.equal(count(svg, 'class="wb"'), 1, 'one writer badge — the unknown writer id renders nothing')
  assert.equal(count(svg, '≋'), 2, 'both faulted pairs marked')
  assert.equal(count(svg, '✂'), 1, 'one cut marked — the ghost pair is skipped, absence renders as absence')
  assert.equal(count(svg, 'class="lc"'), 1, 'the faulted+cut pair takes the WORST stroke (cut)')
  assert.equal(count(svg, 'class="lf"'), 1, 'the fault-only pair keeps the fault stroke')
  assert.ok(svg.includes('1 cut link, 2 faulted links'), 'aria-label counts both')
  assert.equal(count(svg, 'class="ph"'), 3, 'three phase chips')
  assert.ok(svg.includes('pdm crit') && svg.includes('pdm warn'), 'sev maps straight to classes')
})

test('cardHTML: pass pill vs fail note (only on failure), metric rows, escaped click-through href', () => {
  const card = H.cardHTML as (s: unknown) => string
  const base = { nodes: ids(3), mesh: true, phases: [{ label: 'a', sev: 'ok' }, { label: 'b', sev: 'ok' }, { label: 'c', sev: 'ok' }] }
  const ok = card({ id: 'scale-formation', title: 'Scale', kind: 'happy', desc: 'd', diagram: base, pass: true, notes: '', metrics: [{ k: 'nodes', v: 100, kind: 'count' }], base: null })
  assert.ok(ok.includes('href="/debug?scenario=scale-formation"'))
  assert.ok(ok.includes('>pass</span>') && !ok.includes('cnote'), 'a passing card carries NO failure note')
  assert.equal(count(ok, 'class="mxr"'), 1)
  const bad = card({ id: 'x', title: 't', kind: 'unhappy', diagram: base, pass: false, notes: '<b>boom</b>', metrics: [], base: null })
  assert.ok(bad.includes('>fail</span>') && bad.includes('cnote'), 'a failing card shows the note')
  assert.ok(bad.includes('&lt;b&gt;boom&lt;/b&gt;'), 'notes are data, escaped like everything else')
})

test('tallyHTML: all-green pill vs failing crit pill, with rev · reltime · wall bits', () => {
  const tally = H.tallyHTML as (p: unknown, err?: string) => string
  const green = tally({ pass: 20, total: 20, rev: 'abc1234', when: new Date().toISOString(), wallMs: 7010, scenarios: [] })
  assert.ok(green.includes('20/20 passing') && green.includes('pill ok big'))
  assert.ok(green.includes('rev abc1234') && green.includes('7010 ms run'))
  const red = tally({ pass: 19, total: 20, scenarios: [] })
  assert.ok(red.includes('19/20 — 1 failing') && red.includes('pill crit big'))
})
