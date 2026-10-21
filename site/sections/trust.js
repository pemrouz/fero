// sections/trust.js — 04 Why trust it. Every digit goes through attest().
//
// Where everything comes from (nothing is typed):
//  · the point, the band ← data/manifest.json (BUILD): sim.seeds and sim.green (`npm run sim -- --seeds 1000`), the
//    servers and writes per run (sim.line), test.fero (`npm test`), perf (`npm run perf`). The page says these were
//    counted "when this page was made" (never "the build": an insider word).
//  · the grid and the result at rest ← the same manifest (BUILD): the first 100 of those runs, as they ran when this
//    page was made, one row each (sim.runs: { seed, events, cut, green } for seeds 0–99, from tools/runs.mjs, whose
//    totals equal the sweep's). Each square is drawn from its own row: green, with a crack when that run's network
//    was cut. The result beside the grid says the same in numbers: N of 100 runs green, their events (the rows'
//    sum), "as they ran when this page was made". A press compares the tab's events with those rows, run for run.
//    A manifest without the rows falls back to sim.green === sim.seeds (every run passed, so these 100 did: all
//    green, no cracks, no events), and a press compares with the tab's previous run.
//  · "eleven rules" and the door's list ← page.rules: the monitors registered on the kernel this page runs, in order,
//    each with its plain line from core.js RULE_LINES (the one table: the demo's broken-rule note prints the same
//    words). A rule with no line is listed by its own name, so the list never drifts silently.
//  · the run ← sections/trust/sweep.worker.js: seeds 0–99 of the same sweep (sweepBuild(seed, 3, 40)(null), judged
//    as sim/run.ts judges it) in a module Worker, so the page stays free. A press clears the squares and each one
//    fills again from that seed's own message (green, or red with its seed printed); a cut square comes from the
//    run's own plan. N of M green and the events are RUNTIME; the seconds are MEASURED in the Worker ("on this
//    machine"). The run's events are then compared, seed by seed, with the rows from when this page was made when
//    the manifest has them, else with the previous run in this tab: one number, one run.
//  · the result has three rows in every state (N of M runs green · the events · where they come from, or how a run
//    compares), and an empty row keeps its height (trust.css), so a press never changes the section's height.
import { page, attest, put, fmt, onFrame, REDUCED, RULE_LINES } from '../cluster.js'

const root = document.getElementById('trust')
if (root) init()

function init() {
  const $ = (s) => root.querySelector(s)
  const at = (k) => root.querySelector(`[data-tr="${k}"]`)
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  const words = (n) => WORDS[n] ?? fmt(n)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const MADE = 'as they ran when this page was made'

  // ── the eleven rules, from the kernel this page runs (sim/monitors.ts perEvent(), as registered) ─────────────────
  // One plain line each, from core.js RULE_LINES: each says what is checked, none is a promise (FACTS: never
  // "exactly-once" as a promise — the demo above can break that rule in a few clicks, and the line must stay true).
  const rules = page.rules
  attest(at('rules'), words(rules.length), 'runtime')
  attest(at('rules2'), words(rules.length), 'runtime')
  // the door's lead-in says 'After every event, it checks that:', so each line drops its own 'It checks that'
  const bare = (line) => line.replace(/^It checks that,? /, '')
  $('.tr-rules').innerHTML = rules.map((name) => RULE_LINES[name] ? `<li>${esc(bare(RULE_LINES[name]))}</li>` : `<li><code>${esc(name)}</code></li>`).join('')

  // ── the run's pieces ──────────────────────────────────────────────────────────────────────────────────────────
  const btn = $('.tr-go'), btnT = $('.tr-go-t'), grid = $('.tr-grid'), gridSay = $('.tr-grid-say'), out = $('.tr-out'), fails = $('.tr-fails')
  const what = $('.tr-what'), key = $('.tr-key'), line = $('.tr-line'), same = $('.tr-same'), said = at('said')
  const RUNS = +btn.dataset.runs || 100
  // the run count is the page's own choice, printed as literal typography; one constant sizes the grid and the words
  for (const el of root.querySelectorAll('.tr-what [data-literal], .tr-go [data-literal]')) put(el, String(RUNS))
  const lit = `<span data-literal>${RUNS}</span>`
  const cells = []
  for (let i = 0; i < RUNS; i++) { const c = document.createElement('span'); c.className = 'tr-sq'; c.setAttribute('aria-hidden', 'true'); grid.append(c); cells.push(c) }
  // the grid's words, for screen readers and for the honesty gate: the sentence and where its numbers came from
  const gridSays = (text, tier) => { put(gridSay, text); if (tier) grid.setAttribute('data-attested', tier); else grid.removeAttribute('data-attested') }
  // one square, from one run: green or red, with a crack when its network was cut; its title says the rest
  function paint(c, d, whose, pop) {
    c.className = 'tr-sq ' + (d.fail ? 'bad' : 'ok') + (d.cut ? ' cut' : '') + (pop && !REDUCED ? ' pop' : '')
    c.title = `run ${d.seed}` + (d.events != null ? ` · ${fmt(d.events)} events` : '') + (d.cut ? ' · a cut that healed' : '')
      + ` · ${d.fail ? 'failed' + (typeof d.fail === 'string' ? ': ' + d.fail : '') : 'every check passed'}${whose}`
  }
  const label = (glyph, text) => { btnT.innerHTML = (glyph ? `<span aria-hidden="true">${glyph} </span>` : '') + esc(text) }
  // the result's second row: "E events", and once a run in this tab has a time, " · S s on this machine"
  const lineAs = (time) => { line.innerHTML = '<span data-tr="events"></span> events' + (time ? ' · <span data-tr="secs"></span> s on this machine' : '') }
  // the result's third row: where the numbers come from, or how a run compares ('' keeps the row, empty)
  const note = (text, kind = '') => { same.className = 'tr-same' + (kind ? ' ' + kind : ''); put(same, text) }
  // the point's count, again in the line beside the grid ("the first 100 of those 1,000 runs")
  const seedsWhat = (s) => { const el = at('seeds2'); if (el) attest(el, s.seeds, 'build') }
  // the line beside the grid when there is no count to say "of those N runs" with
  const whatNoCount = () => { what.innerHTML = `The first ${lit} runs of that simulator, ready to run on the kernel in your tab.` }

  // ── the numbers from when this page was made (BUILD), and the grid and the result at rest ─────────────────────
  const run = { nodes: 3, writes: 40 } // sim/run.ts's defaults (arg('nodes', 3), arg('writes', 40)) until the manifest says
  let made = null // the events per run when this page was made (sim.runs), when the manifest has them: what a press is compared with
  const manifest = fetch('./data/manifest.json').then((r) => { if (!r.ok) throw new Error(`manifest: ${r.status}`); return r.json() }).then((m) => {
    const s = m.sim
    if (s && s.seeds > 0) {
      attest(at('seeds'), s.seeds, 'build')
      attest(at('green'), s.green, 'build')
      attest(at('of'), s.seeds, 'build')
      seedsWhat(s)
      // the point says "every time" only when every run was green; otherwise it says how many were
      if (s.green !== s.seeds) {
        const t = at('tail'); t.innerHTML = '<span></span> of them end with every copy the same.'
        attest(t.firstChild, s.green, 'build')
      }
      const p = /(\d+) nodes · (\d+) writes/.exec(s.line || '')
      if (p) { run.nodes = +p[1]; run.writes = +p[2] }
      attest(at('nodes'), run.nodes, 'build')
      attest(at('writes'), run.writes, 'build')
      if (m.builtAt) root.querySelector('.tr-band').title = `counted when this page was made: ${new Date(m.builtAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    } else {
      // a manifest without a sweep count: say it without a number, and drop that stat
      put(at('lead'), 'Runs')
      root.querySelector('.tr-band .stat').hidden = true
      whatNoCount()
    }
    const t = m.test && m.test.fero
    if (t && t.tests > 0) attest(at('tests'), t.pass === t.tests ? fmt(t.tests) : `${fmt(t.pass)} of ${fmt(t.tests)}`, 'build')
    const pf = m.perf
    if (pf && pf.tests > 0) attest(at('pins'), pf.pass === pf.tests ? fmt(pf.tests) : `${fmt(pf.pass)} of ${fmt(pf.tests)}`, 'build')
    atRest(s)
  }).catch((e) => {
    // no manifest, no counts: the band goes, the point keeps its words without a count, the run still works
    console.warn('trust: the manifest did not load', e)
    put(at('lead'), 'Runs')
    root.querySelector('.tr-band').hidden = true
    whatNoCount()
  })

  // the first RUNS runs as they ran when this page was made. One row per run when the manifest has them; else every
  // square green when every run of the sweep passed; else the outlines stay and the line says the runs are ready.
  // The result beside the grid says the same in numbers, in the three rows a press fills later.
  function atRest(s) {
    const rows = Array.isArray(s?.runs) && s.runs.length >= RUNS && s.runs.slice(0, RUNS).every((r, i) => r && r.seed === i && Number.isFinite(r.events) && typeof r.cut === 'boolean')
      ? s.runs.slice(0, RUNS) : null
    const whose = ', when this page was made'
    if (rows) {
      rows.forEach((r, i) => paint(cells[i], { ...r, fail: r.green === false }, whose))
      made = rows.map((r) => r.events)
      key.hidden = !rows.some((r) => r.cut)
      const g = rows.filter((r) => r.green !== false).length
      gridSays(`${fmt(g)} of ${fmt(RUNS)} green, ${MADE}.`, 'build')
      shown(g, made.reduce((a, e) => a + e, 0))
    } else if (s && s.seeds >= RUNS && s.green === s.seeds) {
      cells.forEach((c, i) => paint(c, { seed: i }, whose))
      gridSays(`${fmt(RUNS)} of ${fmt(RUNS)} green, ${MADE}.`, 'build')
      shown(RUNS, null)
    } else if (s && s.seeds > 0) {
      what.innerHTML = `The first ${lit} of those <span data-tr="seeds2"></span> runs, one square each, ready to run again on the kernel in your tab.`
      seedsWhat(s)
    } else whatNoCount()
  }
  // the result at rest: N of 100 runs green, their events when the rows say them, and where the numbers come from
  function shown(green, events) {
    out.hidden = false
    out.className = 'tr-out ' + (green === RUNS ? 'ok' : 'bad')
    attest(at('n'), green, 'build'); attest(at('m'), RUNS, 'build'); put(at('k'), 'runs green')
    if (events != null) { lineAs(false); attest(at('events'), events, 'build') } else line.textContent = ''
    note(MADE, 'made')
  }

  // ── the run: seeds 0–99 of the same sweep, in a Worker ────────────────────────────────────────────────────────
  // one run at a time; `last` keeps the previous run's events per seed, so a second run can say whether it matched
  const sw = { worker: null, id: 0, running: false, from: 0, to: RUNS, done: 0, green: 0, events: 0, t: 0, ms: 0,
    ev: [], cut: [], fails: [], dirty: [], last: null, flush: null }

  function worker() {
    if (sw.worker) return sw.worker
    const w = new Worker(new URL('./trust/sweep.worker.js', import.meta.url), { type: 'module' })
    w.onmessage = ({ data }) => onMessage(data)
    w.onerror = (e) => {
      e.preventDefault?.()
      w.terminate(); sw.worker = null
      stopped(`This browser could not start the run${e.message ? ` (${e.message})` : ''}.`)
    }
    return (sw.worker = w)
  }

  async function start() {
    if (sw.running) return
    sw.running = true
    btn.disabled = true
    label('', 'Running…')
    await manifest
    Object.assign(sw, { from: 0, to: RUNS, done: 0, green: 0, events: 0, t: 0, ms: 0, ev: new Array(RUNS).fill(-1), cut: new Array(RUNS).fill(null), fails: [], dirty: [] })
    // the press clears the squares from when this page was made; each fills again as its run ends here
    for (const c of cells) { c.className = 'tr-sq'; c.removeAttribute('title') }
    cells[0].classList.add('next')
    fails.hidden = true; fails.innerHTML = ''
    // the result's three rows now count this tab's run; the third waits, empty, for the comparison. The label stays
    // "runs green" while the count climbs (the button says "Running…"), so the big row never changes its width
    out.hidden = false; out.className = 'tr-out'
    attest(at('n'), 0, 'runtime'); attest(at('m'), RUNS, 'runtime'); put(at('k'), 'runs green')
    lineAs(true); attest(at('events'), 0, 'runtime'); attest(at('secs'), '0.0', 'measured')
    note('')
    gridSays('One square per run. Running in your tab.', 'runtime')
    attest(said, `Running ${RUNS} runs.`, 'runtime')
    sw.flush ??= onFrame(flush)
    sw.id++
    try { worker().postMessage({ id: sw.id, from: sw.from, to: sw.to, nodes: run.nodes, writes: run.writes }) }
    catch (e) { stopped(`This browser could not start the run (${e.message}).`) }
  }

  function onMessage(d) {
    if (d.id !== sw.id) return
    if (d.type === 'seed') {
      const i = d.seed - sw.from
      sw.done++; sw.events += d.events; sw.t = d.t; sw.ev[i] = d.events; sw.cut[i] = d.cut
      if (d.fail) sw.fails.push(d); else sw.green++
      sw.dirty.push(d)
      return
    }
    // done: the worker's own totals are the ones printed
    Object.assign(sw, { running: false, events: d.events, ms: d.ms, done: d.seeds, green: d.seeds - d.failed })
    attest(at('m'), d.seeds, 'runtime')
  }

  // the screen catches up once a frame: the squares that landed since the last frame pop in, the counts follow
  function flush() {
    if (!sw.dirty.length && sw.running) return
    for (const d of sw.dirty) {
      const i = d.seed - sw.from
      paint(cells[i], d, '', true)
      if (d.cut) key.hidden = false
      cells[i + 1]?.classList.add('next')
    }
    sw.dirty.length = 0
    attest(at('n'), sw.green, 'runtime')
    attest(at('events'), sw.events, 'runtime')
    const secs = (sw.running ? sw.t : sw.ms) / 1000
    attest(at('secs'), fmt(Math.round(secs * 10) / 10, 1), 'measured')
    out.classList.toggle('bad', sw.fails.length > 0)
    if (sw.fails.length) renderFails()
    if (!sw.running) finish()
  }

  function finish() {
    sw.flush?.(); sw.flush = null
    for (const c of cells) c.classList.remove('next')
    const all = sw.green === sw.done
    out.classList.toggle('ok', all)
    put(at('k'), all ? 'runs green' : sw.fails.length === 1 ? 'runs green; the red square failed' : 'runs green; the red squares failed')
    // one number, one run: every seed must take exactly the same events as it did when this page was made (when the
    // manifest has the rows), else as in this tab's previous run
    const ref = made ?? sw.last
    if (!ref) note('Run them again: each number should give the very same run.', 'hint')
    else {
      const diff = sw.ev.findIndex((e, i) => e !== ref[i])
      if (diff < 0) note(made ? '✓ Every run took the same events as when this page was made.' : '✓ Every run took exactly the same events as last time.')
      else {
        note('', 'diff')
        same.innerHTML = made
          ? '✕ Not the same as when this page was made: run <span></span> took other events. One number should give one run.'
          : '✕ Not the same as last time: run <span></span> took other events. One number gave two runs, and that is a bug.'
        attest(same.querySelector('span'), sw.from + diff, 'runtime')
      }
    }
    sw.last = sw.ev.slice()
    gridSays(`${fmt(sw.green)} of ${fmt(sw.done)} green in your tab.`, 'runtime')
    attest(said, `${fmt(sw.green)} of ${fmt(sw.done)} runs green, ${fmt(sw.events)} events.`, 'runtime')
    btn.disabled = false
    btn.classList.add('again')
    label('↺', 'Run again')
  }

  function renderFails() {
    fails.hidden = false
    const shown = sw.fails.slice(0, 3)
    fails.innerHTML = shown.map((f) => `<li data-attested="runtime">✕ run ${f.seed}: ${esc(f.fail)}<span class="tr-again">replay it: <code>npm run shrink -- --seed ${f.seed}</code></span></li>`).join('')
      + (sw.fails.length > shown.length ? `<li data-attested="runtime">and ${fmt(sw.fails.length - shown.length)} more</li>` : '')
  }

  function stopped(text) {
    sw.running = false
    sw.flush?.(); sw.flush = null
    out.hidden = false; out.className = 'tr-out bad'
    fails.hidden = false; fails.innerHTML = `<li data-attested="runtime">${esc(text)}</li>`
    gridSays('One square per run. The run in your tab stopped.', 'runtime')
    btn.disabled = false
    label('↺', 'Try again')
  }

  btn.addEventListener('click', start)
  window.__trust = { sw, start, cells, get made() { return made }, set made(v) { made = v } }
}
