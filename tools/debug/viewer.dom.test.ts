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

import { test, before } from 'node:test'
import assert from 'node:assert'
import { runAll } from './scenarios.ts'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { captureSim } from './capture.ts'
import { REC } from '../../kernel/env.ts'
import * as MODEL from './model.mjs'
import { tip } from './eli5.mjs'
import { bootViewer, dragTo } from './dom-shim.ts'

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
