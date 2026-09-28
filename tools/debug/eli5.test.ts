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
import { ABSENT_REASONS, verifyTopology } from './model.mjs'
import { REC, type EffectSink } from '../../kernel/env.ts'
import { Node } from '../../kernel/node.ts'
import { VERB, encodeControl } from '../../kernel/codec.ts'
import { frontier, compact } from '../../kernel/log.ts'

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
      // a LINK selected at present, then carried back to t0 where it is not open yet: the kept selection's pane
      const lk = firstKey('link')
      if (lk) { g(`navTo(${JSON.stringify(lk)})`); dragTo(el, 0); sweep(el, `${id}@t0/kept-selection`); dragTo(el, maxT) }
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
  //! a PROVEN odd one out: two members agree, the third was cut before the writes, run to quiescence — a strict
  // majority, so the header says diverged (the 1-vs-1 cut above is a SPLIT: no side is the cluster, every node is pilled)
  const sim5 = new Sim(5); const trio = cluster(sim5, 3); sim5.run()
  sim5.partition('n01', 'n02'); sim5.partition('n01', 'n03'); writes(sim5, [trio[1]], 4, 10); sim5.run()
  const isolated = captureSim(sim5)
  assert.ok(isolated.quiesced && isolated.nodes.filter((n) => n.stateHash === isolated.nodes[1].stateHash).length === 2, 'two agree, one differs — the fixture is what it claims')
  await drive('isolated', isolated)
  //! a cluster whose journal RING OVERFLOWED (a tiny cap): the truncated pill, replay ✗, time travel switched off —
  // all from a real producer, never a hand-edited capture
  const sim2 = new Sim(11)
  const small = ['s1', 's2'].map((uuid, i, all) => sim2.add({ uuid, listen: `sim:${uuid}`, hosts: all.filter((_, j) => j !== i).map((u) => `sim:${u}`), redialMs: 20, journalCap: 8 }))
  for (const n of small) sim2.post(n.uuid, { kind: 'start' })
  writes(sim2, small, 6, 40); sim2.run()
  const truncated = captureLive(small)
  assert.ok(truncated.nodes.some((n) => n.dropped > 0), 'the tiny ring overflowed — the fixture is what it claims')
  await drive('truncated', truncated, '')
  //! a durable node that RESTARTED and wrote again: its new life stamps under `uuid~2` (the lane-rebirth
  // rule — ISSUES I-1), which the journal-derived topology replay cannot reproduce, so verifyTopology refuses
  // it: the one truthful producer whose links/streams must fall back to the END tables under scrub (the
  // '@ end' marker and its reason). The other node replays fine — both paths paint in one capture.
  const sim4 = new Sim(21); const pair4 = cluster(sim4, 2, { durable: true }); writes(sim4, pair4, 6, 100); sim4.run()
  sim4.restart('n01'); sim4.run()
  for (let i = 0; i < 3; i++) sim4.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`after${i}`], value: i }] }, i * 5)
  sim4.run()
  const reborn = captureSim(sim4)
  const verdicts = verifyTopology(reborn) as { ok: boolean }[]
  assert.ok(verdicts.some((r) => !r.ok) && verdicts.some((r) => r.ok), 'the reborn writer is refused by the topology proof, its peer is not — the fixture is what it claims')
  await drive('reborn', reborn, '')
  //! a node with a debugger ATTACHED (a latched DIAG session beside one admitted peer, then a write — kernel/diag.test's
  // in-process recipe): the session's own line paints as an observer, on the end table and under scrub
  const sink = { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {} } as unknown as EffectSink
  const aa = new Node({ uuid: 'aa', listen: 'sim:aa', diag: { allow: { ops: 'tok' } } }, { now: () => 0, rng: () => 0, sink })
  aa.step({ kind: 'start' })
  aa.step({ kind: 'linkUp', link: 8, dialed: true, to: 'sim:bb' }); aa.step({ kind: 'bytesIn', link: 8, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  aa.step({ kind: 'linkUp', link: 9, dialed: false }); aa.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.HELLO, { u: 'dbg', i: 1, l: '', r: 2, t: 'tok' }) })
  aa.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const observed = captureLive([aa])
  assert.ok(observed.nodes[0].links.some((l) => l.diag), 'the session latched — the fixture is what it claims')
  await drive('observed', observed, '')
  //! a COMPACTED log: churn on four keys, then every member compacts below the frontier — the journals still name the
  // collapsed writes but no record book holds them any more, so those routes say "record not captured" (the honest
  // absence; until I-1 was fixed only the reborn writer's phantom routes painted it)
  const sim6 = new Sim(92); cluster(sim6, 3, { heartbeatMs: 50, durable: true }); sim6.run({ until: 400 })
  for (let i = 0; i < 30; i++) sim6.at(50 + i * 15, () => sim6.post(`n0${1 + (i % 3)}`, { kind: 'write', recs: [{ type: REC.update, key: [`c${i % 4}`], value: i }] }))
  sim6.run({ until: 1500 })
  let gone = 0
  for (const n of sim6.nodes.values()) for (const o of n.logs.keys()) { const f = frontier(n, o); if (f > 0) gone += compact(n, o, f) }
  assert.ok(gone > 0, 'compaction collapsed history — the fixture is what it claims')
  await drive('compacted', captureSim(sim6))
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
  'route:dup': 'a duplicate-only route needs a dupDrop row with NO apply row in the retained journal — trimmed history, which full-ring producers never show',
  'stop:duplicate': 'same — the route stop for a duplicate-only node',
  'torn-read': 'needs a REAL attach over sockets with a write landing mid-pull — attach.test paints it; the offline sweep has no wire',
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
