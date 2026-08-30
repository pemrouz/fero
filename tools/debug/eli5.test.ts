//! ── tools/debug/eli5.test — the glossary gate: every painted data-tip resolves, every entry is reachable ──
// The ELI5 layer is chrome, so the fold-honesty gate does not see it; THIS file polices it the same way,
// in both directions: (1) a key a page paints that ./eli5.mjs lacks is a silent no-tooltip — rejected;
// (2) an entry no page can paint is dead copy that rots unread — rejected. The sweep drives the REAL page
// scripts (the dom-shim harness) over REAL-PRODUCER captures (the scenario registry, a live capture of
// real nodes, an attach envelope with every absent reason) and collects the data-tip keys they paint,
// then diffs against the glossary. Closed vocabularies (the kernel's JK kinds, the registry's metric keys
// and phase labels) are pinned statically so a new kind/metric/phase without an entry fails here first.

import { test, before } from 'node:test'
import assert from 'node:assert'
import { JK } from '../../kernel/journal.ts'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { runAll } from './scenarios.ts'
import { captureLive, captureSim, captureAttached } from './capture.ts'
import { ELI5, tip, tipHTML, phaseKey } from './eli5.mjs'
import { bootViewer, bootScenarios, bootScenariosPure, dragTo } from './dom-shim.ts'
import { ABSENT_REASONS } from './model.mjs'

type Entry = { t: string; d: string }
const G = ELI5 as Record<string, Entry>
const KEYS = Object.keys(G)
const keysIn = (html: string) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1])

let run: ReturnType<typeof runAll>
before(() => { run = runAll() })

test('every entry is a term + a plain explanation, bounded like a tooltip, and no two entries share copy', () => {
  assert.ok(KEYS.length >= 150, `the glossary is populated (${KEYS.length} entries)`)
  const seen = new Map<string, string>()
  for (const k of KEYS) {
    const e = G[k]
    assert.ok(e && typeof e.t === 'string' && typeof e.d === 'string', `${k}: {t, d} strings`)
    assert.ok(e.t.trim().length >= 1 && e.t.length <= 48, `${k}: term label 1..48 chars (${e.t.length})`)
    assert.ok(e.d.trim().length >= 24 && e.d.length <= 340, `${k}: explanation 24..340 chars (${e.d.length}) — a tooltip, not a page`)
    assert.ok(!/\bTODO\b|\bTBD\b/.test(e.d), `${k}: no placeholders`)
    assert.ok(!seen.has(e.d), `${k}: explanation duplicates ${seen.get(e.d)} — alias the key, don't copy the words`)
    seen.set(e.d, k)
  }
})

test('tip/tipHTML/phaseKey laws: exact keys only, escaped output, no card for an unknown key', () => {
  assert.equal(tip('constructor'), null, 'a prototype name is not an entry')
  assert.equal(tip(null), null)
  assert.equal(tipHTML('no-such-key'), '', 'unknown → empty, never a card')
  const html = tipHTML('seq', `<b>&"'`)
  assert.ok(html.startsWith('<div class="e5t">') && html.includes('<div class="e5d">'), 'term + explanation')
  assert.ok(html.endsWith('<div class="e5f">&lt;b&gt;&amp;&quot;&#39;</div>'), 'the fact line is escaped')
  assert.equal(tipHTML('seq'), tipHTML('seq', ''), 'no fact → no fact line')
  assert.equal(phaseKey('converge ×100'), 'p:converge', 'a ×N size suffix is stripped')
  assert.equal(phaseKey('dedup ×4,950'), 'p:dedup')
  assert.equal(phaseKey('3× same key'), 'p:3× same key', 'a leading multiplier is part of the phase')
  assert.equal(phaseKey('HELLO'), 'p:hello')
  assert.equal(phaseKey(undefined), 'p:')
})

test('the kernel\'s closed JK vocabulary is explained in full — every kind, and no jk: entry for a kind that does not exist', () => {
  for (const name of Object.keys(JK)) assert.ok(tip('jk:' + name), `jk:${name} has no ELI5 — the journal vocabulary grew; explain the new kind`)
  for (const k of KEYS) if (k.startsWith('jk:')) assert.ok(k.slice(3) in JK, `${k} names a kind the kernel does not emit — dead copy`)
})

test('the scenario registry\'s metric keys, phase labels and phase colours are explained — and every m:/p: entry is one the registry paints', () => {
  const metrics = new Set<string>(), phases = new Set<string>(), sevs = new Set<string>()
  for (const s of run.results.scenarios) {
    for (const m of s.metrics) metrics.add('m:' + m.k)
    for (const p of s.diagram.phases) { phases.add(phaseKey(p.label)); if (p.sev) sevs.add('psev:' + p.sev) }
  }
  for (const k of [...metrics, ...phases, ...sevs]) assert.ok(tip(k), `${k} has no ELI5 (registry → glossary)`)
  for (const k of KEYS) {
    if (k.startsWith('m:')) assert.ok(metrics.has(k), `${k}: no scenario reports this metric — dead copy`)
    if (k.startsWith('p:')) assert.ok(phases.has(k), `${k}: no scenario has this phase — dead copy`)
    if (k.startsWith('psev:')) assert.ok(sevs.has(k), `${k}: no phase carries this colour — dead copy`)
  }
})

//! the sweep — every surface the viewer paints, over every real capture we can produce offline
const sweepViewer = async () => {
  const painted = new Set<string>()
  const dangling = new Map<string, string>()
  const take = (where: string, html: string) => {
    for (const k of keysIn(html)) { painted.add(k); if (!tip(k)) dangling.set(k, where) }
  }
  const sinks = ['tree', 'insp', 'omenu', 'statusRight', 'crumb', 'ochips', 'srcName']
  const sweep = (el: (id: string) => any, where: string) => {
    for (const id of sinks) take(`${where}#${id}`, el(id).innerHTML)
    if (el('trange').dataset.tip) take(`${where}#trange`, `data-tip="${el('trange').dataset.tip}"`)   // set through dataset, not innerHTML
  }
  // the static chrome (the omni box, the scrubber) is markup, not a render sink — read it straight from the page
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8')
  take('markup', html.slice(0, html.indexOf('<script type="module">')))
  const drive = async (id: string, cap: unknown, search?: string) => {
    const { el, g } = await bootViewer(id, cap, search != null ? { search } : {})
    sweep(el, id)
    // select the first row of EVERY type the forest holds (navTo reveals ancestors), sweeping each inspector
    const types = ['group', 'node', 'link', 'stream', 'write', 'cell', 'violation'] as const
    // the first row of a type, optionally the first at a severity (so pilled rows — diverged, contested, in-flight — get their inspector swept)
    const firstKey = (t: string, sev = '') => g(`(function(){ const q=[...FOREST]; while(q.length){ const n=q.shift(); if(n.type===${JSON.stringify(t)} && (${JSON.stringify(sev)} === '' || n.sev === ${JSON.stringify(sev)})) return n.key; if(n.kids) q.push(...n.kids) } return '' })()`) as string
    const visit = (where: string) => {
      for (const t of types) for (const sev of ['', 'crit', 'warn', 'info']) {
        const k = firstKey(t, sev); if (k) { g(`navTo(${JSON.stringify(k)})`); sweep(el, `${where}/${t}${sev ? '@' + sev : ''}`) }
      }
    }
    visit(id)
    // the omni completions for every head, plus the curated default
    for (const q of ['', 'i', 'is:', 'node:', 'origin:', 'key:', 'write:', 'cell:', 'link:', 'kind:', 'wr', 'is:cr']) {
      el('q').value = q; el('q').fire('input', { target: { value: q } }); take(`${id}/omni(${q})`, el('omenu').innerHTML); take(`${id}/tree(${q})`, el('tree').innerHTML)
    }
    el('q').value = ''; el('q').fire('input', { target: { value: '' } })
    // mid-scrub at several points: replayed surfaces (tree stats, node/write/cell inspectors, the banner, the chip)
    const maxT = Number(el('trange').max)
    if (maxT > 1 && !el('trange').disabled) {
      for (const f of [0.25, 0.5, 0.75]) { dragTo(el, Math.floor(maxT * f)); visit(`${id}@t${f}`) }
      dragTo(el, 0); visit(`${id}@t0`)
      dragTo(el, maxT)
    }
  }
  for (const [id, cap] of run.captures) await drive(id, cap)
  //! a LIVE capture of real nodes frozen MID-FLIGHT (run to a horizon, not to quiescence): the poll path with
  // writes still travelling (in-flight pills, not-yet-arrived stops), then a deep-linked scrub point → paused
  // 600 writes in a burst so the Writes group overflows its 500-row paint cap (the honest '… older writes' row);
  // slow links (up to 30 virtual ms) so plenty are still travelling at the horizon
  const sim = new Sim(7); const nodes = cluster(sim, 3, { fault: { delay: [1, 30], dupP: 0 } }); sim.run()
  writes(sim, nodes, 600, 15); sim.run({ until: sim.now + 20 })
  const live = captureLive([...sim.nodes.values()])
  await drive('live', live, '')
  await drive('live-paused', live, '?t=1')
  //! a PROVEN loss: a cluster that formed, was cut and never healed, run to quiescence — the only producer that
  // can honestly say a write never arrived (nothing is in flight, nothing more is coming)
  const sim3 = new Sim(5); const pair = cluster(sim3, 2); sim3.run()
  sim3.partition(pair[0].uuid, pair[1].uuid); writes(sim3, pair, 4, 10); sim3.run()
  const lost = captureSim(sim3)
  assert.ok(lost.quiesced, 'the cut cluster ran to quiescence')
  await drive('lost', lost)
  //! a cluster whose journal RING OVERFLOWED (a tiny cap): the truncated pill, replay ✗, time travel switched off —
  // all from a real producer, never a hand-edited capture
  const sim2 = new Sim(11)
  const small = ['s1', 's2'].map((uuid, i, all) => sim2.add({ uuid, listen: `sim:${uuid}`, hosts: all.filter((_, j) => j !== i).map((u) => `sim:${u}`), redialMs: 20, journalCap: 8 }))
  for (const n of small) sim2.post(n.uuid, { kind: 'start' })
  writes(sim2, small, 6, 40); sim2.run()
  const truncated = captureLive(small)
  assert.ok(truncated.nodes.some((n) => n.dropped > 0), 'the tiny ring overflowed — the fixture is what it claims')
  await drive('truncated', truncated, '')
  //! an ATTACH envelope with every absent reason and no nodes (the honest 'no nodes' header)
  await drive('attached', captureAttached([], ABSENT_REASONS.map((reason: string, i: number) => ({ target: `127.0.0.1:${i + 1}`, reason }))), '')
  return { painted, dangling }
}

//! the dashboard sweep — the fetch→render path over the real payload, plus the pure renderers' rarer branches
const sweepDashboard = async () => {
  const painted = new Set<string>(), dangling = new Map<string, string>()
  const take = (where: string, html: string) => { for (const k of keysIn(html)) { painted.add(k); if (!tip(k)) dangling.set(k, where) } }
  const { el } = await bootScenarios(run.results)
  take('grid', el('grid').innerHTML); take('tally', el('tally').innerHTML); take('basenote', el('basenote').innerHTML)
  const H = bootScenariosPure()
  const card = H.cardHTML as (s: unknown) => string, delta = H.fmtDelta as (m: unknown, b: unknown) => string
  const s0 = run.results.scenarios[0]
  take('fail-card', card({ ...s0, pass: false, notes: 'x', base: null }))
  take('delta-same', delta({ k: 'events', v: 5, kind: 'count' }, { events: 5 }))
  take('delta-drift', delta({ k: 'events', v: 6, kind: 'count' }, { events: 5 }))
  take('delta-ms', delta({ k: 'wall ms', v: 30, kind: 'ms' }, { 'wall ms': 20 }))
  take('delta-hot', delta({ k: 'wall ms', v: 90, kind: 'ms' }, { 'wall ms': 20 }))
  // the static bar chrome (markup, not a render sink) — read straight from the page
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('./scenarios.html', import.meta.url), 'utf8')
  take('markup', html.slice(0, html.indexOf('<script type="module">')))
  return { painted, dangling }
}

//! keys the offline sweep cannot paint from a truthful producer — each with the reason. Anything else in
// the glossary that the sweep never painted is dead copy and fails below.
const UNREACHABLE_OFFLINE: Record<string, string> = {
  'mid-flight': 'needs a SHRUNK capture frozen at its violating step — shrinking rides only on a FAILING sweep, and the suite is green by contract',
  'shrunk': 'same — a shrunk capture exists only for a failing run',
  'violations': 'no truthful offline producer records a violation: the kernel does not break its own invariants on demand',
  'violation': 'same — the violation row/pill needs a recorded violation',
  'g:violations': 'same — the group appears only when the capture holds one',
  'not-captured': 'needs a write whose record no log still holds — compaction past 4096 entries per lane, or an attach that pulled journals but not logs; no cheap truthful producer',
  'route:dup': 'a duplicate-only route needs a dupDrop row with NO apply row in the retained journal — trimmed history, which full-ring producers never show',
  'stop:duplicate': 'same — the route stop for a duplicate-only node',
}

let viewer: Awaited<ReturnType<typeof sweepViewer>>, dash: Awaited<ReturnType<typeof sweepDashboard>>
before(async () => { viewer = await sweepViewer(); dash = await sweepDashboard() })

test('no dangling key: every data-tip either page paints resolves in the glossary', () => {
  const bad = [...viewer.dangling, ...dash.dangling]
  assert.deepEqual(bad, [], `painted keys with no ELI5: ${bad.map(([k, w]) => `${k} (${w})`).join(', ')}`)
})

test('no dead copy: every glossary entry is painted by the sweep (closed vocabularies pinned above; documented exceptions only)', () => {
  const painted = new Set([...viewer.painted, ...dash.painted])
  assert.ok(painted.has('kind:live') && painted.has('live') && painted.has('live-paused'), 'the live drives painted the live chrome')
  assert.ok(ABSENT_REASONS.every((r: string) => painted.has('absent:' + r)), 'every absent reason was painted')
  const unreached = KEYS.filter((k) => !painted.has(k) && !/^(jk|m|p|psev):/.test(k) && !(k in UNREACHABLE_OFFLINE))
  assert.deepEqual(unreached, [], `glossary entries no surface painted: ${unreached.join(', ')}`)
  for (const k of Object.keys(UNREACHABLE_OFFLINE)) {
    assert.ok(tip(k), `${k} is listed as unreachable but is not an entry — prune the list`)
    assert.ok(!painted.has(k), `${k} WAS painted — it no longer belongs in UNREACHABLE_OFFLINE`)
  }
})

test('the dashboard\'s hover layer mounts and answers a hover through the registered document listener', async () => {
  const { hover, document } = await bootScenarios(run.results)
  const api = (document as unknown as { __eli5: { card: any } }).__eli5
  assert.ok(api, 'mountTips ran on the dashboard document')
  hover('m:events')
  const e = tip('m:events') as Entry
  assert.ok(api.card.classList.contains('on') && api.card.innerHTML.includes(e.d), 'the card carries the metric explanation')
  hover(null)
  assert.equal(api.card.classList.contains('on'), false)
})
