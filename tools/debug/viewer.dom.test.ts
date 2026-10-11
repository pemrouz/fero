//! ── tools/debug/viewer.dom.test — the UI-WIRING gate: the viewer's script executes, and scrubbing visibly changes what it paints ──
// The lesson this file exists for (M8, user-reported): "stateAt is genuine time travel" was green
// while dragging the actual scrubber changed nothing a user could see — the MODEL was tested, the
// page's wiring and render consumption were not. This suite closes that class without a browser or
// a dependency: it extracts viewer.html's inline script, executes it in a minimal DOM shim under
// node:vm against REAL scenario captures (the same runAll() producers the dashboard serves — never
// hand-authored fixtures, per the honesty rules), then drives the REGISTERED event listeners (drag =
// input, wheel, click, reset) and asserts the innerHTML sinks the page paints from actually change.
// A shim cannot prove pixels; it CAN prove every render string the page would paint — which is
// exactly the layer that silently rotted.
//
// If the viewer grows a DOM API this shim lacks, the script throws at load and this suite fails
// loudly — extend the shim (./dom-shim.ts, shared with eli5.test.ts); never stub the assertion.

//! the battery pins first: one case composes a real fero() and its #directory (config layer off)
import '../../utils/battery.ts'

import { test, before } from 'node:test'
import assert from 'node:assert'
import { runAll } from './scenarios.ts'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { captureSim, captureLive } from './capture.ts'
import { REC, type EffectSink } from '../../kernel/env.ts'
import { Node } from '../../kernel/node.ts'
import { VERB, encodeControl } from '../../kernel/codec.ts'
import * as MODEL from './model.mjs'
import { tip } from './eli5.mjs'
import { bootViewer, dragTo } from './dom-shim.ts'
import { scopedCut, scopedTenure, unscopedLeaver } from './fixtures.ts'
import { fero } from '../../api/index.ts'
import { diag } from '../../api/diagnostics.ts'
import { ports } from '#utils'

let captures: Map<string, unknown>
before(() => { captures = runAll().captures as Map<string, unknown> })

test('scrubbing a WRITE-FREE capture (formation — the reported case) still visibly changes the tree', async () => {
  const { el, g } = await bootViewer('formation', captures.get('formation'))
  assert.equal(el('trange').disabled, false, 'scrubber enabled')
  const maxT = Number(el('trange').max)
  assert.ok(maxT > 0, 'maxT > 0')
  const atEnd = el('tree').innerHTML
  dragTo(el, Math.floor(maxT / 2))
  assert.equal(el('tread').textContent, `@ ${Math.floor(maxT / 2)}/${maxT}`, 'the readout follows the drag')
  assert.notEqual(el('tree').innerHTML, atEnd, 'the TREE visibly changes mid-scrub — even with zero writes/cells')
  assert.match(el('tree').innerHTML, /\d+\/\d+<span class="su"> jrnl/, 'node rows show journal progress ≤ t / retained')
  dragTo(el, maxT) // dragging to the end is "present" — the scrub state fully resets
  assert.equal(g('T'), null, 'T at max resets to present')
  assert.equal(el('tree').innerHTML, atEnd, 'back at present, the tree is byte-identical to the end render')
})

test('scrubbing replays state everywhere it is painted: tree, node inspector, write route, status bar', async () => {
  const { el, g } = await bootViewer('replication', captures.get('replication'))
  const maxT = Number(el('trange').max)
  const atEnd = el('tree').innerHTML

  // t=0: no write has happened anywhere — every replayed surface must say so
  dragTo(el, 0)
  assert.notEqual(el('tree').innerHTML, atEnd, 'tree at t0 differs from the end render')

  // select a node THROUGH the registered tree click listener (the real interaction path)
  const iNode = g('(renderTree(), flat.findIndex(r => r.n.type === "node"))')
  assert.ok(iNode >= 0)
  el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(iNode) } } : null) } })
  const insp0 = el('insp').innerHTML
  assert.match(insp0, /replayed @ t0/, 'the inspector carries the time-travel banner')
  assert.match(insp0, /<dt[^>]*>keys<\/dt><dd[^>]*>0 <span class="x">@ t0/, 'replayed key count at t0 is exactly 0 (anchored: "20" must not satisfy it)')
  assert.match(insp0, /≤ t0/, 'the journal pane is scoped to the scrub point')
  for (const [, ts] of insp0.matchAll(/class="stp">t(\d+)</g))
    assert.ok(Number(ts) <= 0, 'no mini-log row from the future')
  assert.match(el('statusRight').innerHTML, /@ t0/, 'the status bar mirrors the scrub point')

  // the same node's inspector CHANGES as t moves (the "drag does nothing" regression, at the pane level)
  dragTo(el, Math.floor(maxT / 2))
  assert.notEqual(el('insp').innerHTML, insp0, 'the node inspector follows the scrub')

  // a write's route timeline at t0 claims nothing about the future. Write rows only exist in
  // `flat` once their group is open — expand it exactly as a user's click on the group row would
  const iGrp = g('(renderTree(), flat.findIndex(r => r.n.key === "g/writes"))') as number
  assert.ok(iGrp >= 0, 'the Writes group row exists')
  el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(iGrp) } } : null) } })
  const iWrite = g('flat.findIndex(r => r.n.type === "write")') as number
  assert.ok(iWrite >= 0, 'an expanded Writes group exposes write rows (replication has 30 routes)')
  dragTo(el, 0)
  el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(iWrite) } } : null) } })
  assert.match(el('insp').innerHTML, /not arrived by t0/, 'route stops the replay has not reached say so')
  assert.match(el('insp').innerHTML, /by t0/, 'the header rollup counts at the scrub point, not end-of-run')
  dragTo(el, maxT)
  assert.doesNotMatch(el('insp').innerHTML, /not arrived by t/, 'at present the route shows its real outcomes')
  assert.match(el('insp').innerHTML, /origin|applied/, 'end-of-run verdicts are back')
})

test('a scrubbed route pane never names the end-of-run LWW winner (conflict — elections mid-replay)', async () => {
  const { el, g } = await bootViewer('conflict', captures.get('conflict'))
  const maxT = Number(el('trange').max)
  // find a write that LOST an election somewhere, at a stop the scrub can stand on (t < maxT)
  const routes = MODEL.routes(JSON.parse(JSON.stringify(captures.get('conflict')))) as Map<string, any>
  let target: { origin: string; seq: number; t: number } | null = null
  for (const r of routes.values())
    for (const s of Object.values(r.nodes) as any[])
      if (s.status === 'lww-lost' && s.t != null && s.t < maxT && !target) target = { origin: r.origin, seq: r.seq, t: s.t }
  assert.ok(target, 'the conflict scenario has an lww-lost stop below maxT')
  g(`navTo('g/writes/${target!.origin}#${target!.seq}')`)
  assert.match(el('insp').innerHTML, /lost LWW<\/span> to/, 'at present the loser names its winner (beatenBy)')
  dragTo(el, target!.t) // stand exactly on the losing stop: the loss is a fact here…
  const insp = el('insp').innerHTML
  assert.match(insp, /lost LWW/, 'the at-T loss renders')
  assert.doesNotMatch(insp, /lost LWW<\/span> to/, '…but the END-of-run winner is never named mid-replay')
  assert.doesNotMatch(insp, /class="ih (crit|warn)"/, 'no end-verdict severity colour on the scrubbed header')
})

test('wheel with no capture loaded is inert (the error pane must not throw into derive(null))', async () => {
  const { el, g } = await bootViewer('formation', captures.get('formation'), { failFetch: true })
  assert.match(el('tree').innerHTML, /Couldn't load/, 'boot fell into the honest error pane')
  el('scrub').fire('wheel', { deltaY: 120 })          // must be a no-op, not a TypeError
  assert.equal(g('T'), null, 'wheel without a capture does not move time')
})

test('the wheel steps time; reset restores the present — both through their registered listeners', async () => {
  const { el, g } = await bootViewer('replication', captures.get('replication'))
  const maxT = Number(el('trange').max)
  const step = Math.max(1, Math.round(maxT / 200))
  el('scrub').fire('wheel', { deltaY: 120 })                   // wheel down from present → step back
  assert.equal(g('T'), maxT - step, 'wheel down steps back from the present')
  el('scrub').fire('wheel', { deltaY: 120 })
  assert.equal(g('T'), maxT - 2 * step, 'wheel keeps stepping')
  el('scrub').fire('wheel', { deltaY: -120 })                  // wheel up → forward
  assert.equal(g('T'), maxT - step, 'wheel up steps forward')
  el('scrub').fire('wheel', { deltaY: 0, deltaX: 40 })         // a purely horizontal pan is not a time gesture
  assert.equal(g('T'), maxT - step, 'deltaY 0 does not step time')
  el('treset').fire('click')                                   // the ✕ resets to present
  assert.equal(g('T'), null, 'reset restores the present')
  const atEnd = el('tree').innerHTML
  for (let i = 0; i < 300; i++) el('scrub').fire('wheel', { deltaY: 120 })
  assert.equal(g('T'), 0, 'wheel clamps at t0, never negative')
  el('treset').fire('click')
  assert.equal(el('tree').innerHTML, atEnd, 'reset renders byte-identical to the end state')
})

test('the ELI5 layer is wired: hovering a painted [data-tip] paints the glossary card; leaving, pressing, or an unknown key clears it', async () => {
  const { el, g, hover, fireDoc } = await bootViewer('replication', captures.get('replication'))
  assert.ok(g('document.__eli5 != null'), 'mountTips ran on the document')
  assert.ok(g('document.head.children.some(c => c.id === "<style>" && /\\.e5\\b/.test(c.textContent))'), 'the card CSS was injected into <head>')
  const card = () => ({ html: g('document.__eli5.card.innerHTML') as string, on: g('document.__eli5.card.classList.contains("on")') as boolean })
  // a key the tree really paints — the node row's seq stat
  assert.match(el('tree').innerHTML, /data-tip="seq"/, 'the tree paints a seq stat with its ELI5 key')
  hover('seq')
  const e = tip('seq') as { t: string; d: string }
  assert.ok(card().on, 'the card shows after the (immediate, shimmed) settle')
  assert.ok(card().html.includes(e.t) && card().html.includes(e.d), 'the card carries the glossary entry verbatim')
  // a fact rides under the explanation, escaped
  hover('node:truncated', '<7> dropped')
  assert.ok(card().html.includes('&lt;7&gt; dropped'), 'data-tip-fact renders as the dim second line, escaped')
  hover(null)                                                   // onto plain chrome
  assert.equal(card().on, false, 'leaving onto a non-tip element hides the card')
  hover('seq'); fireDoc('mousedown', {})
  assert.equal(card().on, false, 'a press hides the card')
  hover('no-such-key')
  assert.equal(card().on, false, 'an unknown key paints NO card — absence renders as absence')
  assert.equal(card().html, '')
})

test('links and streams REPLAY under scrub — they pop into existence as the scrubber moves (the reported n=100 case, proven on the registry captures)', async () => {
  const countType = (html: string, type: string) => (html.match(new RegExp(`data-type="${type}"`, 'g')) || []).length
  const click = (el: (id: string) => any, i: number) =>
    el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(i) } } : null) } })
  //! formation: a 3-node mesh — every node's Links group goes 0 → full, with a mid-formation step in between
  {
    const { el, g } = await bootViewer('formation', captures.get('formation'))
    const maxT = Number(el('trange').max)
    g(`for (const n of CAP.nodes){ expanded.add('g/nodes/' + n.uuid); expanded.add('g/nodes/' + n.uuid + '/g/links'); expanded.add('g/nodes/' + n.uuid + '/g/streams') } render()`)
    const endLinks = countType(el('tree').innerHTML, 'link')
    assert.ok(endLinks >= 6, `the formed mesh paints every link (${endLinks})`)
    dragTo(el, 0)
    assert.equal(countType(el('tree').innerHTML, 'link'), 0, 'at t0 no line is open — the Links groups are empty')
    assert.match(el('tree').innerHTML, /0\/0<span class="su"> links<\/span>/, 'the links-stat reads 0/0 at t0')
    assert.match(el('tree').innerHTML, /data-tip="links@t"/, 'and is labelled as replayed')
    assert.doesNotMatch(el('tree').innerHTML, /data-tip="at-end"/, 'no node fell back to its end tables')
    const seen = new Set<number>()
    for (let f = 1; f < 20; f++) { dragTo(el, Math.floor((maxT * f) / 20)); seen.add(countType(el('tree').innerHTML, 'link')) }
    assert.ok([...seen].some((c) => c > 0 && c !== endLinks), `intermediate steps show the mesh mid-formation (${[...seen].join(',')})`)
    dragTo(el, maxT)
    assert.equal(countType(el('tree').innerHTML, 'link'), endLinks, 'back at present: the end table, byte for byte')
    // the node inspector and the status bar say so too
    dragTo(el, 0)
    click(el, g('(renderTree(), flat.findIndex(r => r.n.type === "node"))'))
    assert.match(el('insp').innerHTML, /links & streams at the scrub point/, 'the banner now claims links & streams')
    assert.match(el('insp').innerHTML, /No links yet at this point/, 'the Links pane is empty at t0, and says why')
    assert.doesNotMatch(el('insp').innerHTML, /@ capture end/, 'nothing in this inspector is an end fact any more')
    assert.match(el('statusRight').innerHTML, /0\/0 links/, 'the status bar carries the replayed links stat')
    dragTo(el, maxT)
    assert.match(el('insp').innerHTML, /\d+\/\d+ admitted<\/span>/, 'at present the Links pane is the plain end table again')
  }
  //! replication: streams pop in with the writes
  {
    const { el, g } = await bootViewer('replication', captures.get('replication'))
    const maxT = Number(el('trange').max)
    g(`for (const n of CAP.nodes){ expanded.add('g/nodes/' + n.uuid); expanded.add('g/nodes/' + n.uuid + '/g/streams') } render()`)
    const endStreams = countType(el('tree').innerHTML, 'stream')
    assert.ok(endStreams >= 3, `streams at the end (${endStreams})`)
    dragTo(el, 0)
    assert.equal(countType(el('tree').innerHTML, 'stream'), 0, 'no stream before the first record')
    dragTo(el, maxT)
    assert.equal(countType(el('tree').innerHTML, 'stream'), endStreams)
  }
  //! the reported case itself, n=100: n001's links-stat moves — 0/0 at t0, mid-formation a fifth of the way in, 99/99 at present
  {
    const { el } = await bootViewer('scale-formation', captures.get('scale-formation'))
    const maxT = Number(el('trange').max)
    const statOf = () => (el('tree').innerHTML.match(/(\d+\/\d+)<span class="su"> links<\/span>/) || [])[1]
    assert.equal(statOf(), '99/99')
    dragTo(el, 0)
    assert.equal(statOf(), '0/0')
    dragTo(el, Math.floor(maxT / 5))
    const q = statOf()
    assert.ok(q !== '0/0' && q !== '99/99', `a fifth of the way in, n001 is mid-formation (${q})`)
    dragTo(el, maxT)
    assert.equal(statOf(), '99/99')
  }
})

test('the verdict is HONOURED: a node whose topology replay was refused keeps its end tables, labelled everywhere it paints; its peer replays; a selection absent at T is kept', async () => {
  const click = (el: (id: string) => any, i: number) =>
    el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(i) } } : null) } })
  //! the reborn writer (ISSUES I-1): a restarted durable node stamps under uuid~2 — its journal cannot reproduce its stream table
  const sim = new Sim(21); const pair = cluster(sim, 2, { durable: true }); writes(sim, pair, 6, 100); sim.run()
  sim.restart('n01'); sim.run()
  for (let i = 0; i < 3; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`after${i}`], value: i }] }, i * 5)
  sim.run()
  const cap = captureSim(sim)
  const verdict = (MODEL.verifyTopology(cap) as { uuid: string; ok: boolean; reason?: string }[]).find((r) => r.uuid === 'n01')!
  assert.equal(verdict.ok, false); assert.match(verdict.reason!, /^streams size \d+ vs \d+$/)
  const { el, g } = await bootViewer('reborn', cap)
  const maxT = Number(el('trange').max)
  g(`for (const n of CAP.nodes){ expanded.add('g/nodes/' + n.uuid); expanded.add('g/nodes/' + n.uuid + '/g/links'); expanded.add('g/nodes/' + n.uuid + '/g/streams') } render()`)
  dragTo(el, Math.floor(maxT / 2))
  // the forest: n01's Links/Streams groups carry the '@ end' pill with the verdict's reason (info-level), n02's do not
  const groups = JSON.parse(g(`JSON.stringify(FOREST.find(x => x.key === 'g/nodes').kids.map(n => ({ u: n.label, pills: n.kids.map(k => k.pill && k.pill.lab), facts: n.kids.map(k => k.pill && k.pill.fact), sevs: n.kids.map(k => k.sev) })))`))
  assert.deepEqual(groups, [
    { u: 'n01', pills: ['@ end', '@ end'], facts: [verdict.reason, verdict.reason], sevs: ['info', 'info'] },
    { u: 'n02', pills: [null, null], facts: [null, null], sevs: ['', ''] },
  ])
  const tree = el('tree').innerHTML
  assert.match(tree, new RegExp(`data-tip="at-end" data-tip-fact="${verdict.reason}"`), 'the tree paints the reason on the pill')
  assert.match(tree, /data-tip="links@t"/, 'n02 replays')
  assert.match(tree, /data-tip="at-end" data-tip-fact="streams size \d+ vs \d+">\d+\/\d+<span class="su"> links/, "n01's links-stat is labelled as an end fact")
  // is:info surfaces the refused groups (their sev is info)
  el('q').value = 'is:info'; el('q').fire('input', { target: { value: 'is:info' } })
  assert.match(el('tree').innerHTML, /@ end/, 'is:info finds the @ end groups')
  el('q').value = ''; el('q').fire('input', { target: { value: '' } })
  // the inspectors: n01 says '@ capture end' (twice, Links + Streams), n02 says '@ t…'
  const idx = (label: string) => g(`(renderTree(), flat.findIndex(r => r.n.type === 'node' && r.n.label === ${JSON.stringify(label)}))`) as number
  click(el, idx('n01'))
  assert.equal((el('insp').innerHTML.match(/@ capture end/g) || []).length, 2, "n01's Links and Streams panes are end facts")
  assert.match(el('insp').innerHTML, new RegExp(`data-tip="at-end" data-tip-fact="${verdict.reason}"`))
  assert.match(el('insp').innerHTML, /links & streams @ end for 1 node the replay could not reproduce/, 'the banner counts the refused node')
  click(el, idx('n02'))
  assert.match(el('insp').innerHTML, /admitted @ t\d+/, 'n02 replays')
  assert.doesNotMatch(el('insp').innerHTML, /@ capture end/)
  // the LEAF rows of the refused node say it too — inspector and status bar
  g(`navTo(FOREST.find(x => x.key === 'g/nodes').kids.find(n => n.label === 'n01').kids[0].kids[0].key)`)
  assert.match(el('insp').innerHTML, /data-tip="at-end"/, "a refused node's link inspector is labelled")
  assert.match(el('statusRight').innerHTML, /@ capture end/, 'and its status bar')
  g(`navTo(FOREST.find(x => x.key === 'g/nodes').kids.find(n => n.label === 'n01').kids[1].kids[0].key)`)
  assert.match(el('insp').innerHTML, /data-tip="at-end"/, "a refused node's stream inspector is labelled")
  g(`navTo(FOREST.find(x => x.key === 'g/nodes').kids.find(n => n.label === 'n02').kids[0].kids[0].key)`)
  assert.doesNotMatch(el('insp').innerHTML, /@ capture end/, "a replayed node's link inspector is not")
  dragTo(el, maxT)
  //! a selection scrubbed back to before it existed is KEPT and says so; it re-attaches when it reappears
  g(`navTo(FOREST.find(x => x.key === 'g/nodes').kids.find(n => n.label === 'n02').kids[0].kids[0].key)`)
  const sel = g('selKey') as string
  assert.match(el('insp').innerHTML, /link id/)
  dragTo(el, 0)
  assert.equal(g('selKey'), sel, 'the selection survives the scrub')
  assert.match(el('insp').innerHTML, /is not open yet @ t0/, 'the pane says the line is not open yet')
  assert.match(el('insp').innerHTML, /data-tip="not-yet@t"/)
  assert.match(el('statusRight').innerHTML, /not here yet @ t0/)
  dragTo(el, maxT)
  assert.equal(g('selKey'), sel)
  assert.match(el('insp').innerHTML, /link id/, 'back at present the link inspector is back')
})

test('the omni panel never contradicts the count beside it: a fragment with no completion says so, and one that names an address is offered as key: (ISSUES I-40)', async () => {
  const { el } = await bootViewer('replication', captures.get('replication'))
  const type = (q: string) => { el('q').value = q; el('q').fire('input', { target: { value: q } }) }
  type('k4')                                                    // a cell + its writes — matched by the text filter, but no filter head, severity, node or kind completes it
  assert.match(el('ocount').innerHTML, /<span class="fl">[1-9]\d*<\/span> match/, 'the count says the text filter hit rows')
  assert.doesNotMatch(el('omenu').innerHTML, /no matches/, 'the panel must not say "no matches" beside a live match count')
  assert.match(el('omenu').innerHTML, /data-pick="key:k4"/, 'a fragment that names a cell/write address is offered as key:k4')
  type('zzzz')                                                  // names nothing at all
  assert.match(el('ocount').innerHTML, /<span class="fl">0<\/span> matches/)
  assert.match(el('omenu').innerHTML, /no completions for “zzzz” — filtering as text/, 'the panel says what it means: completions, not rows')
  type('write:zz')                                              // a facet value that completes to nothing is not "filtering as text"
  assert.match(el('omenu').innerHTML, /no write: value matches “zz”/)
})

test('a /capture.json that is not there yet is WAITED for, not given up on: the page says so, asks again at the poll cadence, and needs no reload (ISSUES I-39)', async () => {
  //! the reader's order in 23-live: the debugger is started first, live.ts writes `capture 1` a moment later
  const sim = new Sim(7); const nodes = cluster(sim, 3); sim.run(); writes(sim, nodes, 12, 20); sim.run()
  const live = captureLive([...sim.nodes.values()])
  let present = false
  const fetch = async () => (present ? { ok: true, json: async () => JSON.parse(JSON.stringify(live)) } : { ok: false, status: 404 })
  const { el, g, timers } = await bootViewer('live', live, { search: '', fetch })
  const pump = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  assert.equal(g('CAP'), null, 'nothing loaded yet')
  assert.match(el('tree').innerHTML, /Waiting for <b>\/capture\.json<\/b>/, 'the page says it is waiting, not that it failed')
  assert.match(el('tree').innerHTML, /HTTP 404/, 'and why, verbatim')
  assert.doesNotMatch(el('tree').innerHTML, /Couldn't load/)
  assert.equal(timers.length, 1, 'one retry is scheduled'); assert.equal(timers[0].ms, 1500, 'at the poll cadence')
  timers.shift()!.fn(); await pump()                            // still absent: the page keeps waiting and re-arms
  assert.equal(g('CAP'), null); assert.equal(timers.length, 1, 'a failed retry schedules the next')
  present = true                                                // `capture 1` lands
  timers.shift()!.fn(); await pump()
  assert.ok(g('CAP != null'), 'the retry loaded the capture — no reload')
  assert.equal(g('LIVE'), true, 'a live capture starts the poll path')
  assert.match(el('srcName').innerHTML, /live · 3 nodes/, 'the source label paints live')
  assert.doesNotMatch(el('tree').innerHTML, /Waiting for/)
})

//! two producers the severity gates are proven on (never hand-authored): a 3-node sim caught MID-FLIGHT (run to a
// horizon over slow links — writes still travelling, kind 'sim', not quiesced) and a QUIESCED cluster whose one
// isolated member provably holds different data (two agree, the cut one never got the writes; nothing more is coming)
const midFlight = () => {
  const sim = new Sim(7); const nodes = cluster(sim, 3, { fault: { delay: [1, 30], dupP: 0 } }); sim.run()
  writes(sim, nodes, 30, 15); sim.run({ until: sim.now + 20 })
  const cap = captureSim(sim)
  assert.equal(cap.quiesced, false, 'the horizon stopped the run with things still moving')
  assert.ok(new Set(cap.nodes.map((n) => n.stateHash)).size > 1, 'the horizon caught the nodes apart — the fixture is what it claims')
  return cap
}
const isolatedWriter = () => {
  const sim = new Sim(5); const nodes = cluster(sim, 3); sim.run()
  sim.partition('n01', 'n02'); sim.partition('n01', 'n03'); writes(sim, [nodes[1]], 4, 10); sim.run()
  const cap = captureSim(sim)
  assert.ok(cap.quiesced, 'the cut cluster ran to quiescence')
  const h = (u: string) => cap.nodes.find((n) => n.uuid === u)!.stateHash
  assert.ok(h('n02') === h('n03') && h('n01') !== h('n02'), 'two agree, the isolated one differs — a strict majority')
  return cap
}

test('divergence is CRIT only where the capture can PROVE it (a quiesced sim); live and mid-flight captures paint warn "differs (in flight)" (ISSUES I-4)', async () => {
  const type = (el: (id: string) => any, q: string) => { el('q').value = q; el('q').fire('input', { target: { value: q } }) }
  //! mid-flight: the header, the node rows and the cell rows are all warn — nothing is proven wrong
  {
    const { el, g } = await bootViewer('mid', midFlight())
    assert.match(el('statusRight').innerHTML, /class="sst warn" data-tip="differs">differs \(in flight\)</, 'the header says differs (in flight), amber')
    assert.doesNotMatch(el('statusRight').innerHTML, /diverged ✗/, 'and never claims divergence it cannot prove')
    g(`expanded.add('g/cells'); render()`)
    const tree = el('tree').innerHTML
    assert.doesNotMatch(tree, /data-sev="crit"/, 'no row is crit on a capture that is still moving')
    assert.match(tree, /data-tip="node:differs"/, 'the off-modal node carries the warn differs pill')
    assert.match(tree, /data-tip="cell:differs"/, 'a cell the nodes disagree on carries the warn differs pill')
    assert.doesNotMatch(tree, /data-tip="(node|cell):diverged"/)
    type(el, 'is:crit'); assert.match(el('ocount').innerHTML, /<span class="fl">0<\/span> matches/, 'is:crit finds nothing')
    type(el, 'cell:differs'); assert.match(el('ocount').innerHTML, /<span class="fl">[1-9]/, 'cell:differs is the matching filter value')
    type(el, '')
    const iNode = g(`(renderTree(), flat.findIndex(r => r.n.type === 'node' && r.n.pill))`) as number
    assert.ok(iNode >= 0)
    el('tree').fire('click', { target: { closest: (s: string) => (s === '.trow' ? { dataset: { i: String(iNode) } } : null) } })
    assert.match(el('insp').innerHTML, /<dt[^>]*>stateHash<\/dt><dd class="warn">/, "the inspector's fingerprint is amber, not red")
  }
  //! quiesced: the isolated member IS diverged — crit everywhere, as before
  {
    const { el, g } = await bootViewer('isolated', isolatedWriter())
    assert.match(el('statusRight').innerHTML, /class="sst crit" data-tip="diverged">diverged ✗</)
    g(`expanded.add('g/cells'); render()`)
    const tree = el('tree').innerHTML
    assert.match(tree, /data-type="node"[^>]*data-sev="crit"/, 'the isolated node is crit')
    assert.match(tree, /data-tip="node:diverged"/); assert.match(tree, /data-tip="cell:diverged"/)
    assert.doesNotMatch(tree, /data-tip="(node|cell):differs"/)
  }
})

test('the route timeline says "never arrived" only where the pill can (a settled sim); elsewhere a missing stop is "not yet arrived" (ISSUES I-5)', async () => {
  //! the first route with a node that has no row for it — on a sim capture, routes() marks it never-arrived either way
  const missingStop = (cap: any) => {
    for (const r of (MODEL.routes(JSON.parse(JSON.stringify(cap))) as Map<string, any>).values())
      if (Object.values(r.nodes).some((s: any) => s.status === 'never-arrived')) return `g/writes/${r.origin}#${r.seq}`
    assert.fail('no route with a missing stop')
  }
  {
    const cap = midFlight()
    const { el, g } = await bootViewer('mid', cap)
    g(`navTo(${JSON.stringify(missingStop(cap))})`)
    assert.match(el('insp').innerHTML, /data-tip="stop:inflight">not yet arrived</, 'mid-flight: the stop is on its way')
    assert.doesNotMatch(el('insp').innerHTML, /never arrived/, 'a sim that is still moving cannot say never')
    assert.match(el('tree').innerHTML, /data-tip="write:in-flight"/, 'and the pill agrees')
  }
  {
    const cap = isolatedWriter()
    const { el, g } = await bootViewer('isolated', cap)
    g(`navTo(${JSON.stringify(missingStop(cap))})`)
    assert.match(el('insp').innerHTML, /data-tip="stop:never">never arrived</, 'quiesced: the loss is proven')
    assert.match(el('tree').innerHTML, /data-tip="write:never-arrived"/)
  }
})

//! a node with a debugger ATTACHED — a latched DIAG session on link #9 — beside one admitted peer, then one write
// (kernel/diag.test's in-process recipe): the capture's link table carries diag:true for the session's own line
const observed = () => {
  const sink = { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {} } as unknown as EffectSink
  const node = new Node({ uuid: 'aa', listen: 'sim:aa', diag: { allow: { ops: 'tok' } } }, { now: () => 0, rng: () => 0, sink })
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 8, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 8, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  node.step({ kind: 'linkUp', link: 9, dialed: false })
  node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.HELLO, { u: 'dbg', i: 1, l: '', r: 2, t: 'tok' }) })
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const cap = captureLive([node])
  assert.deepEqual(cap.nodes[0].links.map((l) => [l.id, l.admitted, l.diag]), [[8, true, false], [9, false, true]], 'one admitted peer, one latched debugger — the fixture is what it claims')
  return cap
}

test("the debugger's own DIAG session is an OBSERVER, not a stuck pre-admit peer: its own pill, left out of the admitted/total stat, on the end table and under scrub (ISSUES I-6)", async () => {
  const cap = observed()
  const { el, g } = await bootViewer('observed', cap, { search: '' })
  const open = () => g(`expanded.add('g/nodes/aa'); expanded.add('g/nodes/aa/g/links'); render()`)
  open()
  const tree = el('tree').innerHTML
  assert.match(tree, /1\/1<span class="su"> links<\/span>/, 'the links stat counts peers only: 1/1, not 1/2')
  assert.match(tree, /data-tip="link:observer"/, 'the session row carries the observer pill')
  assert.doesNotMatch(tree, /data-tip="link:pre-admit"/, 'and is never a pre-admit peer')
  assert.doesNotMatch(tree, /data-sev="info"/, 'an observer is not a transition: no severity')
  g(`navTo('g/nodes/aa')`)
  assert.match(el('insp').innerHTML, /1\/1 admitted</, 'the node inspector counts peers only')
  assert.match(el('insp').innerHTML, /data-tip="link:observer">observer</, 'and names the session row observer')
  g(`navTo('g/nodes/aa/g/links/9')`)
  assert.match(el('insp').innerHTML, /data-tip="link:observer"/, 'the link inspector says what the line is')
  assert.doesNotMatch(el('insp').innerHTML, /unidentified/, 'not "unidentified": the page knows exactly what it is')
  assert.match(el('statusRight').innerHTML, /data-tip="link:observer">observer</, 'and so does the status bar')
  el('q').value = 'link:observer'; el('q').fire('input', { target: { value: 'link:observer' } })
  assert.match(el('ocount').innerHTML, /<span class="fl">1<\/span> match/, 'link:observer is a filter value')
  el('q').value = ''; el('q').fire('input', { target: { value: '' } })
  //! under scrub the replayed table (topologyAt's diagAuth arm) says the same
  const tAuth = cap.nodes[0].journal.find((e) => e.kind === cap.vocab.diagAuth)!.t
  assert.ok(tAuth < Number(el('trange').max), 'the write after the latch leaves the latch row scrubbable')
  dragTo(el, tAuth); open()
  assert.match(el('tree').innerHTML, /data-tip="links@t"/, 'the topology replays')
  assert.match(el('tree').innerHTML, /1\/1<span class="su"> links<\/span>/, 'replayed stat: peers only')
  assert.match(el('tree').innerHTML, /data-tip="link:observer"/, 'replayed row: observer')
  g(`navTo('g/nodes/aa')`)
  assert.match(el('statusRight').innerHTML, /1\/1 links/, 'the status bar at t counts peers only')
})

test('an even split has no modal side: every node is pilled and the header says split — the first-listed node is not "converged" by accident (ISSUES I-7)', async () => {
  //! two members cut from each other, each with its own writes, run to quiescence: one against one
  const sim = new Sim(5); const pair = cluster(sim, 2); sim.run()
  sim.partition(pair[0].uuid, pair[1].uuid); writes(sim, pair, 4, 10); sim.run()
  const lost = captureSim(sim)
  assert.ok(lost.quiesced && lost.nodes[0].stateHash !== lost.nodes[1].stateHash, 'a settled 1 vs 1 — the fixture is what it claims')
  const { el, g } = await bootViewer('lost', lost)
  assert.match(el('statusRight').innerHTML, /class="sst crit" data-tip="split">split ✗ 1 vs 1</, 'the header names the split')
  assert.doesNotMatch(el('statusRight').innerHTML, /diverged ✗/)
  assert.equal((el('tree').innerHTML.match(/data-tip="node:diverged"/g) || []).length, 2, 'both sides are pilled — the situation is symmetric')
  for (const u of ['n01', 'n02']) {
    g(`navTo('g/nodes/${u}')`)
    assert.match(el('statusRight').innerHTML, /data-tip="node:diverged">diverged</, `${u} is not called converged`)
    assert.match(el('insp').innerHTML, /<dt[^>]*>stateHash<\/dt><dd class="bad">/, `${u}'s fingerprint is red`)
  }
  //! a strict majority is still one odd one out: the header says diverged, exactly one node is pilled
  const { el: e2 } = await bootViewer('isolated', isolatedWriter())
  assert.match(e2('statusRight').innerHTML, /diverged ✗/)
  assert.equal((e2('tree').innerHTML.match(/data-tip="node:diverged"/g) || []).length, 1)
})

test('journal kinds this capture never recorded stay out of the kind: suggestions but remain completable by typing (ISSUES I-9)', async () => {
  const { el, g } = await bootViewer('formation', captures.get('formation'))
  const type = (q: string) => { el('q').value = q; el('q').fire('input', { target: { value: q } }) }
  const picks = () => [...el('omenu').innerHTML.matchAll(/data-pick="kind:([^"]+)"/g)].map((m) => m[1])
  const rows = (k: string) => g(`D.kindFreq.get(${JSON.stringify(k)}) || 0`) as number
  assert.equal(rows('holdBack'), 0, 'the reserved kind has no rows anywhere — the fixture is what it claims')
  type('')                                                      // the curated default
  assert.ok(picks().length > 0, 'the default lists kinds')
  for (const k of picks()) assert.ok(rows(k) > 0, `the curated list offers kind:${k}, which this capture never recorded`)
  type('kind:')                                                 // the head alone: the value space, unfiltered
  assert.ok(picks().length > 0)
  for (const k of picks()) assert.ok(rows(k) > 0, `kind: offers kind:${k}, which has zero rows here`)
  type('kind:hold')                                             // typing a fragment still completes a reserved name — an old capture must stay filterable
  assert.deepEqual(picks(), ['holdBack'], 'the fragment completes the reserved kind')
  assert.match(el('omenu').innerHTML, /data-pick="kind:holdBack"[^>]*>[\s\S]*?<span class="oc">0<\/span>/, 'with its honest zero count')
})

//! a cluster whose journal RING OVERFLOWED (journalCap 8 — model.test's recipe): a real producer, never a hand-edited capture
const truncatedPair = () => {
  const sim = new Sim(11)
  const small = ['s1', 's2'].map((uuid, i, all) => sim.add({ uuid, listen: `sim:${uuid}`, hosts: all.filter((_, j) => j !== i).map((u) => `sim:${u}`), redialMs: 20, journalCap: 8 }))
  for (const n of small) sim.post(n.uuid, { kind: 'start' })
  writes(sim, small, 6, 40); sim.run()
  const cap = captureLive(small)
  assert.ok(cap.nodes.every((n) => n.dropped > 0), 'both rings overflowed — the fixture is what it claims')
  return cap
}

test('a truncated journal is a WARNING said out loud: the header says replay unchecked, the scrubber says rewind off, the pill carries the count — never replay ✗', async () => {
  const cap = truncatedPair()
  const { el } = await bootViewer('truncated', cap, { search: '' })
  const head = el('statusRight').innerHTML
  const drop = (u: string) => cap.nodes.find((n) => n.uuid === u)!.dropped
  assert.match(head, new RegExp(`class="sst warn" data-tip="replay-truncated">replay unchecked — journal truncated \\(s1: ${drop('s1')} dropped, s2: ${drop('s2')} dropped\\)<`), 'amber, with every truncated node and its count')
  assert.doesNotMatch(head, /replay ✗/, 'a lost diary page is not a replay fault')
  assert.doesNotMatch(head, /replay ✓/, 'and nothing was checked, so no tick either')
  assert.equal(el('trange').disabled, true, 'the scrubber is off')
  assert.equal(el('tread').textContent, 'rewind off — truncated', 'and the bar says why, in words — not only in a hover')
  assert.equal(el('tread').dataset.tip, 'time-travel-off', 'its hover explains it')
  assert.equal(el('treset').style.display, 'none')
  const tree = el('tree').innerHTML
  assert.match(tree, new RegExp(`data-tip="node:truncated"[^>]*><span class="pd"></span>truncated \\+${drop('s1')}<`), 'the pill carries the count')
  //! the journal stat keeps its short form (`8 +7 jrnl`, amber, the count in its hover): `8 +7 dropped jrnl` was
  // driven in Chromium and clipped its 96 px column (134 px) — the pill and the header carry the word instead
  assert.match(tree, new RegExp(`${cap.nodes[0].journal.length} \\+${drop('s1')}<span class="su"> jrnl`), 'and so does the journal stat')
})

test('a scoped capture paints a non-holder QUIET: no in-flight pill, "applied 2/2 holders", and a "not a holder" stop at every step (ISSUES I-3)', async () => {
  const cap = captures.get('scoped') as { nodes: { uuid: string; holders?: Record<string, string[]> }[] }
  const { el, g } = await bootViewer('scoped', cap)
  g(`expanded.add('g/writes'); render()`)
  const tree = el('tree').innerHTML
  assert.match(tree, /data-type="write"/, 'the writes are painted')
  assert.doesNotMatch(tree, /data-tip="write:(in-flight|never-arrived)"/, 'no write is flagged as still travelling or lost')
  assert.match(tree, /data-tip="route:holders">applied 2\/2 holders</, 'the denominator is the holders, not the cluster')
  assert.doesNotMatch(tree, /⊘/, 'nobody is listed as missing it')
  //! a plain route: written by one of its 2 holders, applied by the other, quiet at the other 3 of the 5 members
  type R = { origin: string; seq: number; partition: string; nodes: Record<string, { status: string; t: number | null; from?: string }> }
  const all = [...(MODEL.routes(cap) as Map<string, R>).values()]
  const plain = all.find((r) => Object.values(r.nodes).filter((x) => x.status === 'not-a-holder').length === 3 && Object.values(r.nodes).filter((x) => x.status === 'applied').length === 1)!
  assert.ok(plain, 'the scoped scenario has a route that never moved — the fixture is what it claims')
  g(`navTo(${JSON.stringify(`g/writes/${plain.origin}#${plain.seq}`)})`)
  const insp = el('insp').innerHTML
  assert.equal((insp.match(/data-tip="stop:not-a-holder">not a holder — never meant to get it</g) || []).length, 3, 'three of five stops are non-holders')
  assert.doesNotMatch(insp, /stop:(never|inflight)/)
  //! rewound to t0: the non-holders stay "not a holder" (never meant to get it at any step); the holders have not got it yet
  dragTo(el, 0)
  const insp0 = el('insp').innerHTML
  assert.equal((insp0.match(/data-tip="stop:not-a-holder"/g) || []).length, 3)
  assert.match(insp0, /applied 0\/2 holders by t0/, 'the rewound rollup counts holders too')
})

test('a scoped capture paints a write a new holder copied in with its row as "got it in a hand-off" from its teacher, counted as received (ISSUES I-3)', async () => {
  const cap = captures.get('scoped')
  type R = { origin: string; seq: number; nodes: Record<string, { status: string; t: number | null; from?: string }> }
  const moved = [...(MODEL.routes(cap) as Map<string, R>).values()].find((r) => Object.values(r.nodes).some((x) => x.status === 'acquired'))!
  assert.ok(moved, 'the join moved a written row — the fixture is what it claims')
  const [who, stop] = Object.entries(moved.nodes).find(([, x]) => x.status === 'acquired')!
  const { el, g } = await bootViewer('scoped', cap)
  g(`navTo(${JSON.stringify(`g/writes/${moved.origin}#${moved.seq}`)})`)
  const insp = el('insp').innerHTML
  assert.ok(insp.includes(`<span class="ref" data-rkey="g/nodes/${who}">${who}</span></span><span data-tip="stop:acquired">got it in a hand-off</span> from <span class="ref" data-rkey="g/nodes/${stop.from}">${stop.from}</span> <span class="x" data-tip="t">· t${stop.t}</span>`), 'the stop names the teacher and the acquire row')
  const meant = Object.values(moved.nodes).filter((x) => x.status !== 'not-a-holder').length
  assert.match(insp, new RegExp(`applied ${meant}/${meant} holders`), 'a hand-off counts as received')
  assert.doesNotMatch(insp, /stop:(never|inflight)/)
})

test('a SYSTEM resource wears a quiet # badge: a real server and the #directory it hosts, captured through the internals door — the user node carries no badge', async () => {
  const rz = `127.0.0.1:${await ports.free()}`
  const f = await fero('shop', { server: true, rendezvous: rz, heartbeat: { ms: 100 } })
  let cap: { nodes: { uuid: string; name?: string }[] }
  try {
    const host = diag(f)!.rendezvous()!.host
    assert.ok(host, 'this server won the bind and hosts the directory — the fixture is what it claims')
    cap = { ...captureLive([]), nodes: [diag(f)!.capture(), diag(host)!.capture()] }
  } finally { await f.destroy() }
  assert.deepEqual(cap.nodes.map((n) => n.name), ['shop', '#directory'], 'the name rides the capture (diagNode)')
  const [shop, dir] = cap.nodes.map((n) => n.uuid)
  const { el, g } = await bootViewer('named', cap, { search: '' })
  const row = (uuid: string) => (el('tree').innerHTML.match(new RegExp(`<div class="trow[^"]*"[^>]*data-type="node"[^>]*>(?:(?!<div class="trow).)*?>${uuid}<(?:(?!<div class="trow).)*`, 's')) ?? [''])[0]
  assert.ok(row(shop).includes(`>${shop}<`) && row(dir).includes(`>${dir}<`) && !row(shop).includes(`>${dir}<`), 'each row is found, and alone')
  assert.match(row(dir), /<span class="tag" data-tip="node:system">#directory<\/span>/, 'the #directory row carries the # tag beside its label')
  assert.doesNotMatch(row(dir), /data-sev="(warn|crit)"/, 'a badge, not a problem: no severity')
  assert.doesNotMatch(row(dir), /class="pill /, 'the pill slot stays for problems')
  assert.doesNotMatch(row(shop), /node:system/, 'the user resource carries no badge')
  g(`navTo('g/nodes/${dir}')`)
  assert.match(el('insp').innerHTML, /<dt data-tip="node:system">resource<\/dt><dd class="">#directory <span class="x">system<\/span><\/dd>/, 'the inspector names the resource and says system')
  g(`navTo('g/nodes/${shop}')`)
  assert.match(el('insp').innerHTML, /<dt data-tip="resource">resource<\/dt><dd class="">shop<\/dd>/, 'a user node shows its name plainly')
  assert.ok(tip('node:system') && tip('resource'), 'both keys explain themselves')
})

//! the capture the badge is FOR: the user's resource holding data beside its #directory. The two resources hold
// different data by design, so the page judges each by itself (agreement(), wave 5e): neither node is pilled, the
// header says converged, every cell and write wears its resource's tag, and a write's stops are its own resource's.
test('a capture of two resources is judged per resource: a server holding a row beside its #directory agrees, the # tag shows, cells and writes name their resource (wave 5e)', async () => {
  const rz = `127.0.0.1:${await ports.free()}`
  const f = await fero('shop', { server: true, rendezvous: rz, heartbeat: { ms: 100 }, data: { widgets: { stock: 3 } } })
  let cap: { nodes: { uuid: string; name?: string; stateHash: number }[] }
  try {
    const host = diag(f)!.rendezvous()!.host
    assert.ok(host, 'this server won the bind and hosts the directory')
    cap = { ...captureLive([]), nodes: [diag(f)!.capture(), diag(host)!.capture()] }
  } finally { await f.destroy() }
  assert.notEqual(cap.nodes[0].stateHash, cap.nodes[1].stateHash, 'the fixture is mixed: the two resources hold different state')
  const [shop, dir] = cap.nodes.map((n) => n.uuid)
  const { el, g } = await bootViewer('mixed', cap, { search: '' })
  const row = (uuid: string) => (el('tree').innerHTML.match(new RegExp(`<div class="trow[^"]*"[^>]*data-type="node"[^>]*>(?:(?!<div class="trow).)*?>${uuid}<(?:(?!<div class="trow).)*`, 's')) ?? [''])[0]
  assert.doesNotMatch(row(dir), /data-tip="node:(differs|diverged)"/, 'the #directory is not pilled: it is compared with no one')
  assert.doesNotMatch(row(shop), /data-tip="node:(differs|diverged)"/, 'and neither is the shop')
  assert.match(el('statusRight').innerHTML, /data-tip="converged">converged ✓</, 'the header says converged')
  assert.match(row(dir), /<span class="tag" data-tip="node:system">#directory<\/span>/, 'the # tag still shows beside the label')
  assert.doesNotMatch(row(shop), /node:system/, 'the user resource carries no badge')
  g(`expanded.add('g/cells'); expanded.add('g/writes'); render()`)
  const tree = el('tree').innerHTML
  assert.match(tree, /data-type="cell"[^>]*>(?:(?!<div class="trow).)*?>widgets<\/span><span class="tag" data-tip="resource">shop<\/span>/s, 'the shop cell wears its resource')
  assert.match(tree, /data-type="write"[^>]*>(?:(?!<div class="trow).)*?<span class="tag" data-tip="resource">shop<\/span>(?:(?!<div class="trow).)*?applied 1\/1</s, 'the seed write wears it too, applied 1/1: the directory node is no stop of it')
  assert.doesNotMatch(tree, /data-tip="(cell|write):(differs|diverged|in-flight|never-arrived)"/, 'no cell or write is flagged')
  assert.doesNotMatch(tree, /⊘/, 'no write lists the other resource as missing it')
  //! the write's inspector lists its own resource's nodes as stops, never the directory
  const w = [...(MODEL.routes(cap) as Map<string, { origin: string; seq: number }>).values()].find((r) => r.origin === shop)
  assert.ok(w, 'the shop wrote its seed — a write to open')
  g(`navTo(${JSON.stringify(`g/writes/${w!.origin}#${w!.seq}`)})`)
  const insp = el('insp').innerHTML
  assert.ok(insp.includes(`data-rkey="g/nodes/${shop}"`), 'the shop node is a stop')
  assert.ok(!insp.includes(`data-rkey="g/nodes/${dir}"`), 'the directory node is no stop of a shop write')
})

test('a scoped capture is judged per row among its holders: the scoped scenario is converged with no pill; a holder that lags on one row is the only node pilled (wave 5e)', async () => {
  {
    const { el } = await bootViewer('scoped', captures.get('scoped'))
    assert.match(el('statusRight').innerHTML, /data-tip="converged">converged ✓</, 'the scenario\'s holders agree row by row: converged')
    assert.doesNotMatch(el('statusRight').innerHTML, /differs \(in flight\)/)
    assert.doesNotMatch(el('tree').innerHTML, /data-tip="node:(differs|diverged)"/, 'no node is pilled — each holds only its rows, by design')
  }
  const { cut, owner, lagging } = scopedCut()
  const { el, g } = await bootViewer('cut', cut)
  assert.match(el('statusRight').innerHTML, /class="sst warn" data-tip="differs">differs \(in flight\)</, 'the holders of one row disagree, mid-flight: amber')
  const pilled = [...el('tree').innerHTML.matchAll(/data-type="node"[^>]*>(?:(?!<div class="trow).)*?<span class="lab" data-tip="node">([^<]+)<(?:(?!<div class="trow).)*?data-tip="node:differs"/gs)].map((m) => m[1])
  assert.deepEqual(pilled, [lagging], 'exactly the lagging holder is pilled')
  g(`expanded.add('g/cells'); render()`)
  assert.match(el('tree').innerHTML, /data-type="cell"[^>]*>(?:(?!<div class="trow).)*?>row<(?:(?!<div class="trow).)*?data-tip="cell:differs"/s, 'the row\'s cell says differs')
  g(`navTo('g/nodes/${lagging}')`)
  assert.match(el('insp').innerHTML, /<dt[^>]*>stateHash<\/dt><dd class="warn">/, 'the lagging holder\'s fingerprint is amber')
  g(`navTo('g/nodes/${owner}')`)
  assert.match(el('insp').innerHTML, /<dt[^>]*>stateHash<\/dt><dd class="">/, 'the owner\'s is not')
  //! a cell is compared among its row's holders only: a member that does not hold the row lacks the cell by design. A
  // scoped run never goes still (heartbeats), so mark a copy of the healed capture quiesced, where a missing cell counts
  const healed = { ...scopedCut().healed, quiesced: true }
  const b = await bootViewer('healed', healed)
  b.g(`expanded.add('g/cells'); render()`)
  assert.match(b.el('tree').innerHTML, /data-type="cell"[^>]*>(?:(?!<div class="trow).)*?>row</s, 'the row\'s cell is on the page')
  assert.doesNotMatch(b.el('tree').innerHTML, /data-tip="cell:(differs|diverged)"/, 'no cell is flagged: the non-holders lacking it are not compared')
})

test('a member that left and a client are judged right on the route: quiet where they were never meant to get a write, in flight only for the one real miss (wave 5e)', async () => {
  const { cap, missed } = scopedTenure()
  type R = { origin: string; seq: number; nodes: Record<string, { status: string }> }
  const rs = [...(MODEL.routes(cap) as Map<string, R>).values()]
  const { el, g } = await bootViewer('tenure', cap)
  //! a write stamped after n04 left: its stop is quiet, never a missing one
  const later = rs.find((r) => r.nodes.n04?.status === 'not-a-holder' && r.nodes.zc1?.status === 'not-a-holder')!
  assert.ok(later, 'a write neither the leaver nor the client was meant to get — the fixture is what it claims')
  g(`navTo(${JSON.stringify(`g/writes/${later.origin}#${later.seq}`)})`)
  let insp = el('insp').innerHTML
  for (const u of ['n04', 'zc1']) assert.ok(insp.includes(`data-rkey="g/nodes/${u}">${u}</span></span><span class="x" data-tip="stop:not-a-holder">`), `${u} is a quiet stop`)
  assert.doesNotMatch(insp, /stop:(never|inflight)/)
  //! the write n04 was meant to get and never did: its stop is the one that says so (amber: a live run is never settled)
  g(`navTo(${JSON.stringify(`g/writes/${missed}`)})`)
  insp = el('insp').innerHTML
  assert.ok(insp.includes(`data-rkey="g/nodes/n04">n04</span></span><span data-tip="stop:inflight">not yet arrived</span>`), 'n04 is the stop still missing it')
})

test('an unscoped member that left tells one story on every pane: converged header, no pill, no cell differs, no write waits for it (wave 5e)', async () => {
  //! the review's capture: the header said converged ✓ while the cell said DIFFERS and three writes said in-flight ⊘ n04
  const { cap, after } = unscopedLeaver()
  const { el, g } = await bootViewer('leaver', cap)
  assert.match(el('statusRight').innerHTML, /data-tip="converged">converged ✓</, 'the three that stay agree: converged')
  assert.doesNotMatch(el('tree').innerHTML, /data-tip="node:(differs|diverged)"/, 'no node is pilled — the leaver keeps an old copy by design')
  g(`expanded.add('g/cells'); expanded.add('g/writes'); render()`)
  const tree = el('tree').innerHTML
  assert.match(tree, /data-type="cell"[^>]*>(?:(?!<div class="trow).)*?>zeta</s, 'the zeta cell is on the page')
  assert.doesNotMatch(tree, /data-tip="(cell|write):(differs|diverged|in-flight|never-arrived)"/, 'no cell or write is flagged')
  assert.doesNotMatch(tree, /⊘/, 'no write lists the leaver as missing it')
  g(`navTo(${JSON.stringify(`g/writes/${after[0]}`)})`)
  const insp = el('insp').innerHTML
  assert.ok(insp.includes('data-rkey="g/nodes/n04">n04</span></span><span class="x" data-tip="stop:not-a-holder">'), 'n04 is a quiet stop of a write made after it left')
  assert.doesNotMatch(insp, /stop:(never|inflight)/)
})

test('a live attach that could not reach the writer still tells one story: converged header, no ⊘ for a member that left or a non-holder (wave 5e review)', async () => {
  //! the review's two captures, as the attach bridge builds them when one target times out: the header said converged ✓
  // above amber ⊘ stops, because with no writer the stops fell back to the old never-arrived rule
  const drop = (cap: { nodes: { uuid: string }[] }, u: string) =>
    ({ ...cap, kind: 'live', seed: null, nodes: cap.nodes.filter((n) => n.uuid !== u), absent: [{ target: '127.0.0.1:9001', reason: 'timeout' }] })
  const { healed, owner } = scopedCut()
  for (const [name, cap] of [['leaverNoWriter', drop(unscopedLeaver().cap, 'n01')], ['scopedNoWriter', drop(healed, owner)]] as const) {
    const { el, g } = await bootViewer(name, cap)
    assert.match(el('statusRight').innerHTML, /data-tip="converged">converged ✓</, `${name}: converged`)
    assert.match(el('statusRight').innerHTML, /absent/, `${name}: the missing target is named`)
    g(`expanded.add('g/writes'); render()`)
    assert.match(el('tree').innerHTML, /data-type="write"/, `${name}: the writes are on the page`)
    assert.doesNotMatch(el('tree').innerHTML, /⊘/, `${name}: no write waits for a node that was never meant to get it`)
    assert.doesNotMatch(el('tree').innerHTML, /data-tip="write:(in-flight|never-arrived)"/)
  }
})
