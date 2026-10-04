// sections/cluster.js — the centrepiece: one cluster, break it (CONCEPT §4 a, §6). THE house cluster, nothing
// else: page (cluster.js) is the one kernel run every figure on the page reads. This file owns the frame loop,
// the stat strip, the caption and the kicker; cluster/dock.js the controls (head row, verbs, floating dock,
// story); cluster/say.js the one plain sentence; cluster/model.js what the page's events taught us;
// cluster/cards.js variant a; and cluster/timeline.js variant b (one lane per node, time left to right).
import { page, attest, onFrame } from '../cluster.js'
import { rec, inspect, esc, nid } from '../ui.js'
import { M, waiting } from './cluster/model.js'
import { paint, sentence, num } from './cluster/say.js'
import { D, STEPS, render as renderDock, pace, storyTick } from './cluster/dock.js'
import * as cardsA from './cluster/cards.js'
import * as timelineB from './cluster/timeline.js'

const root = document.getElementById('cluster')
const $ = (s) => root.querySelector(s)
page.watch(root)
cardsA.setTargetReader(() => D.target)

// ── visibility: the section, and the figure (where frames fly — "watch" slows only while it is seen) ──
let onScreen = false, figSeen = false
const varA = root.querySelector('[data-variant="a"]')
let shownA = !varA.hidden
varA.addEventListener('variantshow', () => { shownA = true; requestAnimationFrame(() => cardsA.relayout()) })
varA.addEventListener('varianthide', () => { shownA = false })
// variant b: the timeline; the caption gains its one sentence about slanted lines while b is shown
const varB = root.querySelector('[data-variant="b"]'), capB = $('#cl-cap-b')
let shownB = !varB.hidden
const syncCapB = () => { if (capB.hidden === shownB) capB.hidden = !shownB }
varB.addEventListener('variantshow', () => { shownB = true; timelineB.shown(); syncCapB() })
varB.addEventListener('varianthide', () => { shownB = false; syncCapB() })
syncCapB()
if ('IntersectionObserver' in window) {
  // root: document keeps the margin inside a cross-origin frame (a hosted preview), where the default root drops it
  const near = (cb) => { try { return new IntersectionObserver(cb, { root: document, rootMargin: '160px 0px' }) } catch { return new IntersectionObserver(cb, { rootMargin: '160px 0px' }) } }
  near((es) => { for (const e of es) onScreen = e.isIntersecting }).observe(root)
  new IntersectionObserver((es) => { for (const e of es) figSeen = e.isIntersecting }, { threshold: 0.15 }).observe(root.querySelector('.opt'))
} else { onScreen = figSeen = true }

// ── the stat strip ──
const S = {
  view: $('#cl-s-view'), members: $('#cl-s-members'), commits: $('#cl-s-commits'), wait: $('#cl-s-wait'),
  agree: $('#cl-s-agree'), of: $('#cl-s-of'), copies: $('#cl-s-copies'), copiesV: $('#cl-s-copies-v'),
  broken: $('#cl-s-broken'), brokenV: $('#cl-s-checks-v'), brokenN: $('#cl-s-broken-n'), rules: $('#cl-s-rules'), events: $('#cl-s-events'),
}
const tog = (el, c, on) => { if (el.classList.contains(c) !== on) el.classList.toggle(c, on) }
function paintStrip() {
  const v = page.view()
  attest(S.view, num(v.epoch))
  // a crashed member stays in the view until the vote drops it: struck through at once, as the rail, the menu's
  // status line and the lede's card show it (the element itself is attested in the html)
  const mh = v.members.length ? v.members.map((m) => (page.down.has(m) ? `<span class="is-down">${nid(m)}</span>` : nid(m))).join(' ') : 'no view yet'
  if (S.members._h !== mh) { S.members._h = mh; S.members.innerHTML = mh }
  attest(S.commits, num(M.commits.size))
  const wn = waiting().length
  attest(S.wait, num(wn)); tog(S.wait.parentElement, 'waiting', wn > 0)
  const c = page.copies()
  attest(S.agree, num(c.agree)); attest(S.of, num(c.of))
  const ok = c.agree === c.of
  tog(S.copiesV, 'ok', ok); tog(S.copiesV, 'cl-wait-v', !ok)
  if (S.copies.textContent !== (ok ? 'agree' : 'agree · the rest differ')) S.copies.textContent = ok ? 'agree' : 'agree · the rest differ'
  // broken counts RULES, not reports: a broken rule is reported again at every later event (sim/monitors.ts), so
  // one breach would otherwise read as thousands. The rules that broke are named in the line below.
  const broken = M.f.broken
  attest(S.broken, num(broken.size)); tog(S.brokenV, 'ok', broken.size === 0); tog(S.brokenV, 'bad', broken.size > 0)
  const names = broken.size ? [...broken.keys()].join(', ') + ' ·' : ''
  if (S.brokenN.textContent !== names) { S.brokenN.textContent = names; S.brokenN.hidden = !names; tog(S.brokenN.parentElement, 'cl-sub-wrap', !!names) }
  attest(S.rules, num(page.rules.length)); attest(S.events, num(page.events))
}

// ── the kicker counts the house's nodes in words ──
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
function paintKicker() {
  const s = page.serverIds.length, c = page.clientIds.length
  const t = `one cluster · ${WORDS[s] ?? s} ${s === 1 ? 'server' : 'servers'} · ${WORDS[c] ?? c} ${c === 1 ? 'client' : 'clients'} · break it`
  const el = $('#cl-kicker'); if (el.textContent !== t) { el.textContent = t; if (/\d/.test(t)) el.setAttribute('data-attested', 'runtime') }
}

// ── the caption: the record an assignment becomes (the latest whole-row write the page posted), the link delay,
// the harness's redial (BUILD), and the two vote times from own runs in a Worker (RUNTIME, simulated) ──
const cap = { assign: $('#cl-cap-assign'), rec: $('#cl-cap-rec'), delay: $('#cl-cap-delay'), x: $('#cl-cap-x'), z: $('#cl-cap-z'), redial: $('#cl-cap-redial'), runs: $('#cl-cap-runs') }
let capKey = ''
function paintCaption() {
  let w = null
  for (let i = page.writes.length - 1; i >= 0; i--) { const x = page.writes[i]; if (!x.remove && x.path.length === 1 && x.value && typeof x.value === 'object') { w = x; break } }
  const key = w ? w.id + '|' + page.seed : 'none|' + page.seed
  if (key === capKey) return
  capKey = key
  const row = w ? w.path[0] : page.writer.row
  const value = w ? w.value : { stock: page.writer.cycle[page.writer.i % page.writer.cycle.length] }
  cap.assign.innerHTML = `shop.data.${esc(row)} = ${inspect(value)}`
  cap.rec.innerHTML = rec({ type: 0, key: [row], value })
}
const [d0, d1] = page.opts.delay
attest(cap.delay, `${num(d0)}–${num(d1)} ms`, 'runtime')
let facts = null, worker = null, asked = -1
fetch('./data/cluster/facts.json').then((r) => r.json()).then((f) => { facts = f; attest(cap.redial, `${num(f.harness.redialMs)} ms`, 'build'); askVotes() }).catch(() => { cap.redial.textContent = 'the harness default' ; cap.redial.removeAttribute('data-attested') })
function askVotes() {
  if (!facts || asked === page.seed || typeof Worker === 'undefined') return
  asked = page.seed
  const seed = page.seed
  cap.x.textContent = 'timing…'; cap.z.textContent = 'timing…'
  cap.x.removeAttribute('data-attested'); cap.z.removeAttribute('data-attested')
  try {
    worker ||= new Worker(new URL('./cluster/vote.worker.js', import.meta.url), { type: 'module' })
    // a worker that cannot load (its import failed) says so instead of "timing…" for ever
    worker.onerror = () => { cap.x.textContent = cap.z.textContent = 'not measured'; cap.x.removeAttribute('data-attested'); cap.z.removeAttribute('data-attested'); worker = null; asked = -1 }
    worker.onmessage = (e) => {
      const r = e.data
      if (r.seed !== page.seed) return
      if (r.error || !(r.x?.ms > 0) || !(r.z?.ms > 0)) { cap.x.textContent = cap.z.textContent = 'not measured'; return }
      attest(cap.x, `${(r.x.ms / 1000).toFixed(1)} s`, 'runtime')
      attest(cap.z, `${(r.z.ms / 1000).toFixed(1)} s`, 'runtime')
      cap.runs.innerHTML = `own runs · seed <span data-attested="runtime">${esc(String(r.seed))}</span>, simulated clock`
    }
    // the same inputs section 02 gives its own runs: fero's defaults from the build, the house link delay
    worker.postMessage({ seed, heartbeatMs: facts.defaults.heartbeatMs, redialMs: facts.defaults.redialMs, delay: page.opts.delay })
  } catch { cap.x.textContent = cap.z.textContent = 'not measured' }
}
page.on('reset', () => { capKey = ''; askVotes() })

// ── the one frame loop (cluster.js's onFrame: runs after the cluster advanced this frame) ──
const nowEl = $('#cl-now')
let lastSlow = 0, lastIdle = 0
// what this section's own frame work costs (read by tools/cluster-controls.mjs): max and count over 12 ms
const perf = { max: 0, over: 0, frames: 0, sum: 0 }
onFrame((t) => {
  const p0 = performance.now()
  frame(t)
  const d = performance.now() - p0
  perf.frames++; perf.sum += d; if (d > perf.max) { perf.max = d; perf.maxAt = Math.round(p0) } if (d > 12) perf.over++
})
function frame(t) {
  storyTick()
  pace(figSeen && onScreen)
  if (onScreen) {
    if (shownA) cardsA.frame()
    if (shownB) timelineB.frame()
    // the sentence, the strip and the tape repaint in the same frame as the cards, so every part of the figure
    // always shows the same instant (each write is guarded: only changed text touches the DOM)
    paint(nowEl, sentence()); paintStrip(); if (shownA) cardsA.slow()
    if (t - lastSlow > 110) { lastSlow = t; paintKicker(); paintCaption(); renderDock() }
  } else if (t - lastIdle > 250) { lastIdle = t; renderDock() }
}
renderDock(true)
// a read-only handle for tools/cluster-*.mjs (the drive tests): the model and the controls' state
window.__clusterSection = { M, D, STEPS, perf, tl: timelineB.debug }
