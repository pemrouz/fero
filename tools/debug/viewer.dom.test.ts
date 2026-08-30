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
