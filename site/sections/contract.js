// sections/contract.js — 05 The contract. Four live parts; every digit goes through attest().
//  1 · The rules: sim/monitors.ts perEvent() as registered on the house cluster (page.rules). The simulator runs
//      one monitor pass after every event (sim/exec.ts run(), checkEvery 1), so "checked N times" is page.events.
//      Broken = page.sim.violations, counted per rule by its monitor name.
//  2 · The sweep: sim/run.ts's loop in a module Worker (contract/sweep.worker.js) over the stripped lib/.
//      Seeds 0–99 run once when the section is first seen; "all" runs data/manifest.json's sim.seeds, and its
//      event total is compared with the build's own `npm run sim` count (manifest sim.events).
//  3 · Same seed, same run: a twin of the visitor's session, built from the seed in a module Worker
//      (contract/replay.worker.js imports core.js) and kept in step: every ~2 s on screen it gets the new actions
//      and checkpoints and is compared on events, traceCount and traceHash.
//  4 · Stated plainly (rung 17): two servers read `counter` from their own copy and write back one more at one
//      simulated moment; then one row per increment. Real page.write calls on the house cluster; every value
//      shown is read back from it. Each write is followed by its attempt identity to its own stamp.
import { page, attest, fmt, REDUCED, stable, pair, keyOf } from '../cluster.js'
import { nid, stamp, rec, inspect, vt, esc } from '../ui.js'

const SEC = document.getElementById('contract')
if (SEC) init(SEC)

function init(sec) {
  const $ = (id) => sec.querySelector('#' + id)
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  const words = (n) => WORDS[n] ?? fmt(n)
  // putHTML: like attest(), for markup built from kernel values (ui.js returns HTML strings). It rewrites the
  // element only when the markup changed, so a steady state keeps its nodes (and their hover notes).
  const putHTML = (el, html, tier = 'runtime') => {
    if (!el) return false
    const changed = el.__html !== html
    if (changed) { el.innerHTML = html; el.__html = html }
    if (html) { if (el.getAttribute('data-attested') !== tier) el.setAttribute('data-attested', tier) } else el.removeAttribute('data-attested')
    return changed
  }
  const hex = (h) => (h >>> 0).toString(16).padStart(8, '0')

  // ── on screen? DOM work pauses while the section is off screen or the tab is hidden ──────────────────
  let onScreen = false, seen = false
  const onFirstSeen = [], onSeen = []
  const seenNow = () => { const first = !seen; seen = true; if (first) for (const f of onFirstSeen) f(); for (const f of onSeen) f() }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      const v = es[es.length - 1].isIntersecting
      if (v === onScreen) return
      onScreen = v
      if (v) seenNow()
    }, { rootMargin: '80px' }).observe(sec)
  } else { onScreen = true; setTimeout(seenNow, 0) }
  page.watch(sec) // the house cluster advances while this section is on screen

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 3a · the replay inputs. page.actions holds the visitor's actions. A confirm probe (page.probe) is also an
  // event in the run, and core.js does not log it, so the sections that probe log it there themselves as
  // { op: 'probe' } (break.js before the call, argument/track.js after it, if nothing logged it). This wrapper
  // does the same for any other caller, and skips a probe its caller has just logged, so each lands once.
  // The checkpoint log holds the checkpoints not yet sent to the twin (between frames, every 250 ms simulated).
  const log = []
  let lastCpAt = -Infinity
  {
    const probe = page.probe
    page.probe = function (on, origin, seq, level) {
      const A = page.actions, last = A[A.length - 1], at = page.now, ev = page.events
      const logged = last && last.op === 'probe' && last.at === at && last.ev === ev && last.args && last.args[0] === on && last.args[1] === origin && last.args[2] === seq && last.args[3] === level
      if (!logged) A.push({ at, ev, op: 'probe', args: [on, origin, seq, level] })
      return probe.call(page, on, origin, seq, level)
    }
  }
  const probesIn = (acts) => { let k = 0; for (const a of acts) if (a.op === 'probe') k++; return k }
  const checkpoint = () => {
    if (page.now - lastCpAt < 250) return
    lastCpAt = page.now
    log.push({ at: page.now, events: page.events, tc: page.traceCount, th: page.traceHash, acts: page.actions.length })
    if (log.length > 60000) thin()
  }
  // drop every other checkpoint if the twin falls far behind (they only locate a divergence)
  function thin() { let w = 0; for (let i = 0; i < log.length; i += 2) log[w++] = log[i]; log.length = w }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 1 · the rules
  const ruleList = $('ct-rules')
  const SCOPED = new Set(['scoped-lawful-holding', 'orphan-frozen'])
  // facts.md §4 — used only for a rule the page's own list lacks
  const GIST = {
    'queued-implies-paused': "frames wait in a link's queue only while that link is paused (its pipe is full).",
    'one-view-per-epoch': 'no two nodes ever install different member lists under one view number. No split brain.',
    'epoch-monotone': "a node's view number never goes down.",
    'log-monotone': "each writer's log stays in strictly rising counter order.",
    'single-writer': 'for any row and any view after the first vote, at most one writer ever stamps it.',
    'attempt-exactly-once': 'one write attempt commits at most one stamp, anywhere in the cluster.',
    'watermark-monotone': 'a node’s “dealt with up to here” mark for each writer never goes down.',
    'watermark-ordering': 'for each writer, applied ≥ shippable ≥ durable, at every instant.',
    'scoped-lawful-holding': 'with replicas, a node holds only rows the current ring gives it.',
    'orphan-frozen': 'with replicas, a row a node should no longer hold stays frozen until it can be dropped safely.',
  }
  const rowOf = new Map()
  {
    const names = page.rules
    for (const li of [...ruleList.children]) rowOf.set(li.dataset.rule, li)
    for (const name of names) if (!rowOf.has(name)) {
      const li = document.createElement('li'); li.className = 'ct-rule'; li.dataset.rule = name
      li.innerHTML = `<span class="ct-rname">${esc(name)}</span><span class="ct-gist">${esc(GIST[name] ?? 'no plain words for this rule on this page yet')}</span><span class="ct-rok">·</span>`
      rowOf.set(name, li)
    }
    for (const name of names) ruleList.append(rowOf.get(name)) // the registration order
    for (const [name, li] of rowOf) if (!names.includes(name)) { li.classList.add('ct-absent'); li.querySelector('.ct-rok').textContent = 'not registered'; ruleList.append(li) }
    for (const li of rowOf.values()) li.__ok = li.querySelector('.ct-rok').innerHTML
    attest($('ct-nrules'), words(names.length), 'runtime')
  }
  let violShown = -1
  // a broken rule in plain words. attempt-exactly-once names the two stamps one write attempt got, as 02 and the
  // centrepiece say it; the monitor's raw text ("attempt c1~1|2 committed TWICE: n02|5|1 and …") stays in the title
  const TWICE = /TWICE: (\S+?)\|(\d+)\|(\d+) and (\S+?)\|(\d+)\|(\d+)/
  const violWords = (v) => {
    const m = v.monitor === 'attempt-exactly-once' && TWICE.exec(v.detail ?? '')
    return m ? `one write attempt got two stamps: ${stamp({ origin: m[1], seq: +m[2], epoch: +m[3] })} and ${stamp({ origin: m[4], seq: +m[5], epoch: +m[6] })}` : esc(v.detail ?? '')
  }
  function renderRules() {
    const V = page.sim.violations, ev = page.events
    attest($('ct-checked'), ev, 'runtime')
    attest($('ct-broken'), V.length, 'runtime')
    sec.querySelector('.ct-law-broken').classList.toggle('bad', V.length > 0)
    const by = new Map(); for (const v of V) by.set(v.monitor, (by.get(v.monitor) ?? 0) + 1)
    for (const [name, li] of rowOf) {
      if (li.classList.contains('ct-absent')) continue
      const ok = li.querySelector('.ct-rok'), k = by.get(name) ?? 0
      if (k) { li.classList.add('broken'); ok.innerHTML = ''; attest(ok, `✕ ${fmt(k)}`, 'runtime'); continue }
      if (li.classList.contains('broken')) { li.classList.remove('broken'); ok.innerHTML = li.__ok; ok.removeAttribute('data-attested') }
      if (!SCOPED.has(name)) attest(ok, ev ? '✓' : '·', 'runtime')
    }
    const head = $('ct-law-ok')
    attest(head, V.length ? '✕' : ev ? '✓' : '·', 'runtime')
    head.classList.toggle('bad', V.length > 0)
    head.title = V.length ? 'a rule broke on the cluster above: it is listed under the table' : 'no rule broken on the cluster above'
    if (V.length !== violShown) {
      violShown = V.length
      const list = $('ct-viol')
      list.hidden = V.length === 0
      list.innerHTML = V.slice(0, 5).map((v) => `<li data-attested="runtime" title="${esc(`the monitor's own words: ${v.detail ?? ''}`)}"><b>${esc(v.monitor)}</b> broke at event ${fmt(v.event)}: ${violWords(v)}</li>`).join('')
        + (V.length > 5 ? `<li data-attested="runtime">and ${fmt(V.length - 5)} more</li>` : '')
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · the sweep
  const grid = $('ct-grid'), cells = []
  for (let i = 0; i < 100; i++) { const c = document.createElement('span'); c.className = 'ct-cell'; grid.append(c); cells.push(c) }
  // run.ts's defaults (arg('nodes', 3), arg('writes', 40), arg('seeds', 1000)) until the build manifest says
  const sw = { nodes: 3, writes: 40, all: 1000, worker: null, id: 0, running: false, per: 1, to: 0, done: 0, events: 0, failed: 0, t: 0, fails: [], rerun: null, cellDone: [], cellBad: [], cellEv: [], dirty: new Set(), raf: 0, last: null }
  let manifest = null
  const manifestReady = fetch(new URL('../data/manifest.json', import.meta.url)).then((r) => r.json()).then((m) => {
    manifest = m
    const s = m && m.sim
    if (!s) return
    const p = /(\d+) nodes · (\d+) writes/.exec(s.line || '')
    if (p) { sw.nodes = +p[1]; sw.writes = +p[2]; attest($('ct-p-nodes'), sw.nodes, 'build'); attest($('ct-p-writes'), sw.writes, 'build') }
    if (s.seeds > 0) { sw.all = s.seeds; const n = $('ct-n1000'); n.removeAttribute('data-literal'); attest(n, s.seeds, 'build') }
  }).catch(() => {})
  const run100 = $('ct-run100'), runAll = $('ct-run1000'), status = $('ct-sweep-status')
  const setStatus = (html, tier = 'runtime') => putHTML(status, html, tier)

  function worker() {
    if (sw.worker) return sw.worker
    const w = new Worker(new URL('./contract/sweep.worker.js', import.meta.url), { type: 'module' })
    w.onmessage = ({ data: d }) => onSweep(d)
    w.onerror = (e) => {
      e.preventDefault?.()
      sw.running = false; sw.worker = null; w.terminate()
      setStatus(`the sweep could not run here: ${esc(e.message || 'the worker failed to start')}`)
      status.classList.add('bad'); run100.disabled = runAll.disabled = false
    }
    return (sw.worker = w)
  }

  async function runSweep(kind, only) {
    if (sw.running) return
    sw.running = true
    run100.disabled = runAll.disabled = true
    await manifestReady
    const one = only !== undefined
    const from = one ? only : 0, to = one ? only + 1 : kind === 'all' ? sw.all : 100
    Object.assign(sw, { kind, from, to, per: one ? sw.per : Math.max(1, Math.ceil(to / 100)), done: 0, events: 0, failed: 0, t: 0, fails: one ? sw.fails : [], rerun: null })
    if (!one) {
      sw.cellDone = new Array(100).fill(0); sw.cellBad = new Array(100).fill(false); sw.cellEv = new Array(100).fill(0)
      for (const c of cells) { c.className = 'ct-cell'; c.style.removeProperty('--fill'); c.removeAttribute('title') }
      grid.classList.toggle('decades', sw.per > 1)
      $('ct-grid-key').textContent = sw.per > 1 ? `one square = ${words(sw.per)} seeds, filling as they pass` : 'one square = one seed'
      $('ct-cmp').hidden = true
      $('ct-fails').hidden = true; $('ct-fails').innerHTML = ''
      attest($('ct-sweep-own'), `own runs · seeds ${from}–${to - 1}`, 'runtime')
    }
    status.classList.remove('bad')
    setStatus(one ? `rerunning seed ${only}…` : 'running…', 'runtime')
    sw.id++
    try { worker().postMessage({ id: sw.id, from, to, nodes: sw.nodes, writes: sw.writes }) }
    catch (e) { sw.running = false; run100.disabled = runAll.disabled = false; setStatus(`the sweep could not run here: ${esc(e.message)}`); status.classList.add('bad') }
  }

  function onSweep(d) {
    if (d.id !== sw.id) return
    if (d.type === 'seed') {
      if (sw.kind === 'one') { sw.rerun = { seed: d.seed, fail: d.fail, events: d.events }; return }
      sw.done++; sw.events += d.events; sw.t = d.t
      const i = Math.min(99, Math.floor(d.seed / sw.per))
      sw.cellDone[i]++; sw.cellEv[i] += d.events
      if (d.fail) { sw.cellBad[i] = true; sw.failed++; sw.fails.push({ seed: d.seed, fail: d.fail, events: d.events }) }
      sw.dirty.add(i)
      if (!sw.raf) sw.raf = requestAnimationFrame(flushSweep)
      return
    }
    // done
    sw.running = false
    run100.disabled = runAll.disabled = false
    if (sw.kind === 'one') { renderRerun(d); return }
    sw.last = d
    if (!sw.raf) sw.raf = requestAnimationFrame(flushSweep)
    attest($('ct-sweep-own'), `own runs · seeds ${d.from}–${d.to - 1}`, 'runtime')
    setStatus(d.failed ? `<span class="broken">✕ ${fmt(d.failed)} failed</span>` : `<span class="agree-ok">✓ every seed passed</span>`)
    if (sw.kind === 'all') compareWithBuild(d)
    if (d.failed) renderFails()
  }

  function flushSweep() {
    sw.raf = 0
    for (const i of sw.dirty) {
      const c = cells[i], done = sw.cellDone[i], bad = sw.cellBad[i]
      if (sw.per === 1) {
        c.className = 'ct-cell ' + (bad ? 'bad' : 'ok')
        c.title = `seed ${i} · ${fmt(sw.cellEv[i])} events · ${bad ? 'failed' : 'passed every check'}`
      } else {
        const lo = i * sw.per, hi = Math.min(sw.to, lo + sw.per) - 1, of = hi - lo + 1
        c.style.setProperty('--fill', String(done / of))
        c.classList.toggle('bad', bad); c.classList.toggle('ok', done === of && !bad); c.classList.toggle('part', done > 0 && done < of)
        c.title = `seeds ${lo}–${hi} · ${fmt(done)} of ${fmt(of)} run · ${fmt(sw.cellEv[i])} events · ${bad ? 'one failed' : done === of ? 'all passed every check' : 'running'}`
      }
    }
    sw.dirty.clear()
    attest($('ct-s-seeds'), sw.done, 'runtime')
    attest($('ct-s-events'), sw.events, 'runtime')
    attest($('ct-s-failed'), sw.failed, 'runtime')
    $('ct-s-failed').classList.toggle('ok', sw.failed === 0 && !sw.running); $('ct-s-failed').classList.toggle('bad', sw.failed > 0)
    const secs = (sw.running ? sw.t : sw.last ? sw.last.ms : sw.t) / 1000
    attest($('ct-s-time'), secs.toFixed(secs < 10 ? 2 : 1), 'measured')
  }

  // the full sweep's event total against the build's own `npm run sim` count — "the same" only when it is
  function compareWithBuild(d) {
    const el = $('ct-cmp'), s = manifest && manifest.sim
    el.hidden = false
    if (!s || !(s.events > 0) || s.seeds !== d.to || d.from !== 0) {
      el.className = 'ct-cmp'
      el.innerHTML = '<span class="ct-dim">This build’s manifest holds no <code>npm run sim</code> count for these seeds, so there is nothing to compare with.</span>'
      return
    }
    const same = s.events === d.events
    el.className = 'ct-cmp ' + (same ? 'same' : 'diff')
    el.innerHTML = same
      ? `<span class="ct-mark">✓</span><span>the same count <code>npm run sim</code> prints: <b data-attested="build">${fmt(s.events)}</b> events when this page was built, <b data-attested="runtime">${fmt(d.events)}</b> in this tab</span>`
      : `<span class="ct-mark">✕</span><span><code>npm run sim</code> printed <b data-attested="build">${fmt(s.events)}</b> events when this page was built, and this tab counted <b data-attested="runtime">${fmt(d.events)}</b>. They should be the same.</span>`
  }

  // a failed seed prints itself, the way run.ts prints it (a throw has no repro line there), with a rerun
  function renderFails() {
    const el = $('ct-fails')
    el.hidden = false
    el.innerHTML = sw.fails.slice(0, 5).map((f) => `<div class="ct-fail" data-seed="${f.seed}"><pre class="code">✗ seed ${f.seed}: ${esc(f.fail)}${/^threw /.test(f.fail) ? '' : `\n  repro: new Sim(${f.seed}) + cluster(${sw.nodes}) + writes(${sw.writes})`}</pre><button class="act" type="button" data-rerun="${f.seed}">rerun seed <span data-attested="runtime">${f.seed}</span> ▸</button><span class="ct-rerun"></span></div>`).join('')
      + (sw.fails.length > 5 ? `<div class="ct-dim" data-attested="runtime">and ${fmt(sw.fails.length - 5)} more failed seeds</div>` : '')
  }
  $('ct-fails').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rerun]'); if (!b || sw.running) return
    runSweep('one', +b.dataset.rerun)
  })
  // "the same way" only when the rerun failed the same check after the same number of events; anything else
  // means one seed gave two runs, which is a determinism bug, and it says so
  function renderRerun(d) {
    const box = $('ct-fails').querySelector(`.ct-fail[data-seed="${d.from}"] .ct-rerun`)
    const first = sw.fails.find((f) => f.seed === d.from), again = sw.rerun
    if (box && first && again && again.seed === d.from) {
      const same = !!again.fail && again.fail === first.fail && again.events === first.events
      box.classList.toggle('bad', !same)
      attest(box, same ? `failed again, the same way: the same check, after the same ${fmt(again.events)} events`
        : again.fail ? `failed again, but not the same way (${fmt(again.events)} events): one seed gave two runs, and that is a determinism bug`
          : 'passed this time: one seed gave two runs, and that is a determinism bug', 'runtime')
    }
    status.classList.toggle('bad', sw.fails.length > 0)
    setStatus(sw.fails.length ? `<span class="broken">✕ ${fmt(sw.fails.length)} failed</span>` : '')
  }

  run100.addEventListener('click', () => runSweep('first'))
  runAll.addEventListener('click', () => runSweep('all'))
  onFirstSeen.push(() => runSweep('first'))

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 3b · same seed, same run — the twin is built once per run and kept in step: each check sends only the
  // actions and checkpoints since the last one, so a check costs the new events, never the whole session
  const RECHECK_MS = 2000
  const SUB0 = $('ct-verdict-sub').innerHTML
  const rp = { worker: null, id: 0, busy: false, fresh: true, sentActs: 0, actsRef: null, lastAt: -1, lastSend: -Infinity, dead: false, timer: 0, snap: null }
  const verdict = $('ct-verdict'), vsub = $('ct-verdict-sub')
  function replayWorker() {
    if (rp.worker) return rp.worker
    const w = new Worker(new URL('./contract/replay.worker.js', import.meta.url), { type: 'module' })
    w.onmessage = ({ data }) => onReplay(data)
    w.onerror = (e) => {
      e.preventDefault?.()
      rp.busy = false; rp.dead = true; rp.worker = null; w.terminate()
      verdict.className = 'ct-verdict'
      putHTML(verdict, `<span class="ct-dim">the twin could not be built here: ${esc(e.message || 'the worker failed to start')}</span>`)
    }
    return (rp.worker = w)
  }
  function requestReplay() {
    clearTimeout(rp.timer); rp.timer = 0
    if (rp.busy || rp.dead) return
    if (!page.isReady && page.now < 1) { scheduleReplay(800); return }
    const acts = page.actions
    if (acts !== rp.actsRef) { rp.actsRef = acts; rp.sentActs = 0; rp.fresh = true } // a new run (reset)
    if (!rp.fresh && page.now === rp.lastAt && acts.length === rp.sentActs) return // nothing new to check
    // the new entries, merged in the order they happened: a checkpoint taken when k actions existed goes before action k
    const entries = []
    let j = 0
    for (let i = rp.sentActs; i <= acts.length; i++) {
      while (j < log.length && log[j].acts <= i) { const e = log[j++]; entries.push({ op: 'cp', at: e.at, events: e.events, tc: e.tc, th: e.th }) }
      if (i < acts.length) entries.push(acts[i])
    }
    const probes = probesIn(acts)
    const snap = { seed: page.seed, final: { now: page.now, events: page.events, tc: page.traceCount, th: page.traceHash }, probes, actions: acts.length - probes }
    const fresh = rp.fresh
    try {
      replayWorker().postMessage({ id: rp.id + 1, fresh, opts: fresh ? { ...page.opts, seed: page.seed } : null, entries, final: snap.final })
    } catch (e) { rp.dead = true; putHTML(verdict, `<span class="ct-dim">the session could not be sent to the worker: ${esc(e.message)}</span>`); return }
    rp.id++; rp.busy = true; rp.snap = snap
    rp.fresh = false; rp.sentActs = acts.length; rp.lastAt = page.now; rp.lastSend = performance.now()
    log.length = 0
    attest($('ct-replay-own'), `own run · seed ${snap.seed}`, 'runtime')
    if (fresh && !verdict.classList.contains('same')) putHTML(verdict, '<span class="ct-pending">rebuilding the twin…</span>')
  }
  function scheduleReplay(ms) { clearTimeout(rp.timer); rp.timer = setTimeout(() => { rp.timer = 0; if (onScreen && !document.hidden) requestReplay() }, ms) }
  const runHash = '<span class="ct-term" title="run hash: the state of the node that moved, after every event of the run, folded into one number. Two runs share it only if they matched event for event.">run hash</span>'
  const fromWhat = (snap) => !snap.actions && !snap.probes ? `seed <b>${snap.seed}</b> alone`
    : `seed <b>${snap.seed}</b> and <b>${fmt(snap.actions)}</b> ${snap.actions === 1 ? 'action' : 'actions'}${snap.probes ? ` and <b>${fmt(snap.probes)}</b> ${snap.probes === 1 ? 'probe' : 'probes'}` : ''}`
  function onReplay(d) {
    if (d.id !== rp.id) return
    rp.busy = false
    const snap = rp.snap
    if (!d.ok) {
      rp.dead = true
      verdict.className = 'ct-verdict bad'
      putHTML(verdict, `<span class="ct-mark">✕</span><span>the twin could not be built: ${esc(d.error)}</span>`)
      putHTML(vsub, '')
      return
    }
    if (d.same) {
      verdict.className = 'ct-verdict same'
      putHTML(verdict, '<span class="ct-mark">✓</span><span>identical at every event</span>')
      putHTML(vsub, `Rebuilt in a worker from ${fromWhat(snap)}: <b>${fmt(d.events)}</b> events to <b>${esc(vt(snap.final.now))}</b> on the simulated clock, ${runHash} <b class="ct-hash">${hex(d.th)}</b> on both, in <span data-attested="measured"><b>${fmt(Math.round(d.ms))}</b> ms</span> on this machine. It checks again while you watch.`)
    } else {
      verdict.className = 'ct-verdict bad'
      putHTML(verdict, `<span class="ct-mark">✕</span><span>diverged after event <b>${fmt(d.after)}</b>, by event <b>${fmt(d.by)}</b></span>`)
      putHTML(vsub, `That is a bug, most likely in this page: something reached the cluster without going through its action log. Page ${runHash} <b class="ct-hash">${hex(snap.final.th)}</b> at <b>${fmt(snap.final.events)}</b> events · twin <b class="ct-hash">${hex(d.th)}</b> at <b>${fmt(d.events)}</b>${d.threw ? ` · the twin refused ${esc(d.threw.op)}: ${esc(d.threw.message)}` : ''}`)
    }
  }
  onFirstSeen.push(() => scheduleReplay(600))
  onSeen.push(() => { if (rp.lastSend > -Infinity) scheduleReplay(400) })

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 4 · stated plainly — the lost increment, then one row per increment
  const ROW = 'counter', PREFIX = 'add-', COUNTER_KEY = keyOf([ROW]), ADD_KEY = '["' + PREFIX
  const cases = { race: fresh(), rows: fresh() }
  function fresh() { return { start: null, all: [], pair: null, prev: new Map() } }
  let wid = 0
  // when each stamp was made: the first apply of a stamp anywhere is the owner's own, at the stamp site
  // (kernel/node.ts commit applies in the same step). Read only; nothing here acts inside the callback.
  const stampedAt = new Map()
  page.on('apply', (a) => {
    if (a.key !== COUNTER_KEY && !a.key.startsWith(ADD_KEY)) return
    const k = `${a.epoch}.${a.seq}.${a.origin}`
    if (!stampedAt.has(k)) stampedAt.set(k, a.at)
  })
  const liveIds = () => page.ids().filter((id) => page.alive(id) && !page.left.has(id))
  // the two writers: n01 and n03 while both are up, else the first two live servers
  function writers() {
    const live = page.serverIds.filter((id) => page.alive(id) && !page.left.has(id))
    const pick = ['n01', 'n03'].filter((id) => live.includes(id))
    for (const id of live) if (pick.length < 2 && !pick.includes(id)) pick.push(id)
    return pick.length === 2 ? pick : null
  }
  function blocked(c) {
    if (!page.isReady) return 'the cluster is starting'
    const ws = writers()
    if (!ws) return 'this needs two live servers'
    if (ws.some((id) => page.viewOf(id).epoch < 1)) return 'waiting for the servers’ first view'
    if (c.pair && c.pair.writes.some((x) => { const f = fate(x); return f === 'waiting' || f === 'down' })) return 'waiting for the last two writes'
    return ''
  }
  const nOf = (v) => (v && typeof v === 'object' && typeof v.n === 'number' ? v.n : 0)
  // the counter under the biggest stamp any live copy holds: the record every copy ends up keeping. The owner
  // applies a write in the same step it stamps it, so this moves the moment a stamp exists.
  function newestCounter() {
    let best = null, val
    for (const id of liveIds()) { const s = page.stamp(id, ROW); if (s && (!best || cmpStamp(s, best) > 0)) { best = s; val = page.cell(id, ROW) } }
    return nOf(val)
  }
  const isAddKey = (key) => key.startsWith(ADD_KEY) && JSON.parse(key).length === 1
  const addRows = (id) => { let k = 0; for (const key of page.node(id).state.keys()) if (isAddKey(key)) k++; return k }
  // the add rows that exist on any live copy (each lands at its owner the moment it is stamped)
  const addRowsNow = () => { const s = new Set(); for (const id of liveIds()) for (const key of page.node(id).state.keys()) if (isAddKey(key)) s.add(key); return s.size }

  $('ct-race-go').addEventListener('click', () => {
    const c = cases.race
    if (blocked(c)) return
    const [a, b] = writers(), at = page.now
    if (c.start === null) c.start = newestCounter()
    const before = newestCounter()
    // each server reads its own copy (reads never wait), then writes back one more, at the same simulated moment
    const ra = page.object(a)[ROW], rb = page.object(b)[ROW]
    c.pair = { at, before, writes: [post('race', a, ROW, { n: nOf(ra) + 1 }, true, ra), post('race', b, ROW, { n: nOf(rb) + 1 }, true, rb)] }
    renderCases(true)
  })
  $('ct-rows-go').addEventListener('click', () => {
    const c = cases.rows
    if (blocked(c)) return
    const [a, b] = writers(), at = page.now
    if (c.start === null) c.start = addRowsNow()
    const before = addRowsNow()
    const next = (id) => {
      const re = new RegExp(`^${PREFIX}${id}-(\\d+)$`)
      let k = 0
      for (const n of liveIds()) for (const key of page.node(n).state.keys()) { if (!isAddKey(key)) continue; const m = re.exec(String(JSON.parse(key)[0])); if (m) k = Math.max(k, +m[1]) }
      for (const w of page.writes) { const m = re.exec(String(w.path[0])); if (m) k = Math.max(k, +m[1]) }
      return `${PREFIX}${id}-${k + 1}`
    }
    const rowA = next(a), rowB = next(b)
    c.pair = { at, before, writes: [post('rows', a, rowA, { n: 1 }, false), post('rows', b, rowB, { n: 1 }, false)] }
    renderCases(true)
  })

  // post one whole-row write on node `id`, remembering its attempt identity: the kernel mints each attempt as
  // { issuer: uuid~life, cid } (kernel/write.ts) and logs both with the stamp it commits under (kernel/node.ts
  // commit). Two racing writes can carry the same key and value, so only that identity says which stamp is whose.
  function post(kind, id, row, value, hasRead, read) {
    const n = page.node(id)
    const x = { id: ++wid, kind, node: id, row, value, hasRead, read, iss: `${id}~${n.incarnation}`, cidBefore: n.writes.cid, stamp: null, stampAt: 0, gone: '', goneAt: 0 }
    x.w = page.write(id, row, value)
    cases[kind].all.push(x)
    return x
  }
  // the stamp the owner gave this write, read from the kernel's per-writer logs (newest entries first)
  function stampOf(x) {
    if (x.stamp) return x.stamp
    const want = stable(x.value)
    for (const id of page.ids()) {
      const n = page.node(id)
      if (!n) continue
      for (const [origin, entries] of n.logs) {
        for (let i = entries.length - 1, k = 0; i >= 0 && k < 400; i--, k++) {
          const e = entries[i]
          if (e.iss === x.iss && e.cid > x.cidBefore && e.rec.key.length === 1 && e.rec.key[0] === x.row && stable(e.rec.value) === want) {
            x.stamp = { epoch: e.epoch, seq: e.seq, origin }
            x.stampAt = stampedAt.get(`${e.epoch}.${e.seq}.${origin}`) ?? page.now
            return x.stamp
          }
        }
      }
    }
    return null
  }
  // a write's fate, from the kernel's state:
  //   stamped  its owner stamped it (found by attempt identity)
  //   waiting  its writer, in the same life, still holds it in its queue
  //   down     its writer crashed or left, and a WRITE frame from it is still on the wire (it may yet land)
  //   gone     its writer crashed, left or came back in a new life before it committed: the queue it waited in
  //            lived only in that life's memory (the boot record and the WAL hold no waiting writes), and
  //            nothing from that life is left on the wire
  // (memoised per moment: a render asks several times, and the stamp search walks the logs)
  function fate(x) {
    if (x.fAt === page.now && x.fEv === page.events) return x.f
    x.fAt = page.now; x.fEv = page.events
    return (x.f = fateNow(x))
  }
  function fateNow(x) {
    if (x.gone && page.now - x.goneAt > 5000) return 'gone'
    if (stampOf(x)) return 'stamped'
    if (x.gone) return 'gone'
    if (page.alive(x.node) && `${x.node}~${page.life(x.node)}` === x.iss) return 'waiting'
    if (page.inFlight().some((f) => f.from === x.node && f.verb === 'WRITE')) return 'down'
    x.gone = page.left.has(x.node) ? 'left' : 'crashed'; x.goneAt = page.now
    return 'gone'
  }
  // why a write still waits, from the kernel's own state: the writer's gate, then the owner in the writer's own
  // view (the node its kernel sends the write to)
  const GATE = { minority: 'cannot reach a majority of its view', evicted: 'is not in the view', rejoining: 'is rejoining the view', 'stale-epoch': 'is behind on views' }
  function whyWaiting(x) {
    const me = nid(x.node), row = `<code>${esc(x.row)}</code>`
    const g = page.writable(x.node)
    if (g && !g.open) return `${me} ${GATE[g.reason] ?? 'has its write gate closed'}, so it holds the write`
    const o = page.owner(x.row, x.node)
    if (!o) return `${me} has no view yet`
    if (o === x.node) return `${me} owns ${row} and is about to stamp it`
    if (!page.alive(o)) return `${nid(o)}, the owner of ${row}, is down; the others must vote it out first`
    if (page.cuts.has(pair(x.node, o))) return `${me} cannot reach ${nid(o)}, the owner of ${row}`
    return `on its way to ${nid(o, { owner: true })}, the owner of ${row}`
  }
  // one write, as the real objects: who wrote, what it read, the record it posted, then its stamp or its wait.
  // The waiting time sits in its own span, filled after the markup lands, so a waiting line is not rebuilt every tick.
  function writeLine(x) {
    const r = { type: 0, key: [x.row], value: x.value }
    const f = fate(x)
    let st
    if (f === 'stamped') st = stamp(x.stamp)
    else if (f === 'waiting') st = `<span class="waiting">waiting <span class="ct-wt" data-wid="${x.id}"></span> simulated:</span> <span class="ct-why">${whyWaiting(x)}</span>`
    else if (f === 'down') st = `<span class="broken">${esc(x.node)} ${page.left.has(x.node) ? 'left' : 'crashed'} before the write committed</span>`
    else st = `<span class="broken">never committed: ${esc(x.node)} ${x.gone === 'left' ? 'left while the write waited' : 'crashed while the write waited, and a waiting write is not kept on disk'}</span>`
    const owner = page.owner(x.row)
    return `<div class="ct-w"><div class="ct-w-who">${nid(x.node, { owner: x.node === owner })}${!x.hasRead ? ' <span class="ct-w-read">posts</span>' : x.read === undefined ? ` <span class="ct-w-read">found no ${esc(x.row)} row, posts</span>` : ` <span class="ct-w-read">read <span class="ct-v">${inspect(x.read)}</span>, posts</span>`}</div>`
      + `<div class="ct-w-rec">${rec(r)} ${st}</div></div>`
  }
  // what every copy holds now: one line when every live copy holds the same thing, else one line per copy.
  // Returns the keys whose value changed since the last render, to flash them once the markup lands.
  function copiesHTML(c, kind) {
    const owner = kind === 'race' ? page.owner(ROW) : ''
    const live = liveIds(), down = page.ids().filter((id) => !live.includes(id))
    const per = live.map((id) => {
      if (kind === 'race') {
        const val = page.cell(id, ROW), st = page.stamp(id, ROW)
        return { id, v: val === undefined ? '<span class="ct-dim">no counter row yet</span>' : inspect(val), s: st ? stamp(st) : '', sig: st ? `${st.epoch}.${st.seq}.${st.origin}` : '-' }
      }
      const k = addRows(id)
      return { id, v: `${fmt(k)} ${k === 1 ? 'row' : 'rows'} <span class="ct-dim">named ${PREFIX}…</span>`, s: '', sig: String(k) }
    })
    const flash = []
    const seenSig = (key, sig) => { if (c.prev.has(key) && c.prev.get(key) !== sig) flash.push(key); c.prev.set(key, sig) }
    let html = ''
    if (per.length && per.every((x) => x.sig === per[0].sig)) {
      seenSig('*', per[0].sig)
      html = `<div class="ct-every"><span class="ct-ev-k">every copy</span><span class="ct-ev-ids">${per.map((x) => nid(x.id, { owner: x.id === owner })).join(' ')}</span><span class="ct-c-v" data-fk="*">${per[0].v}</span>${per[0].s}</div>`
    } else {
      c.prev.delete('*')
      for (const x of per) seenSig(x.id, x.sig)
      html = per.map((x) => `<div class="ct-copy"><span class="ct-c-id">${nid(x.id, { owner: x.id === owner })}</span><span class="ct-c-v" data-fk="${x.id}">${x.v}</span><span class="ct-c-s">${x.s}</span></div>`).join('')
    }
    if (down.length) html += `<div class="ct-copy is-down"><span class="ct-c-id">${down.map((id) => nid(id)).join(' ')}</span><span class="ct-c-v">${down.map((id) => (page.left.has(id) ? 'left' : 'down ✕')).join(' · ')}</span><span></span></div>`
    return { html, flash }
  }
  const uuidOf = (origin) => String(origin).split('~')[0]
  // how many live copies hold every one of these stamps on their rows
  function holding(writes) {
    const live = liveIds()
    const k = live.filter((id) => writes.every((x) => sameStamp(page.stamp(id, x.row), x.stamp))).length
    return { k, of: live.length, someDown: live.length < page.ids().length }
  }
  // the race, told in the order the stamps were made (the first apply of each stamp), never in stamp order:
  // across views the two differ, and a write stamped later in an older view carries the smaller stamp
  function raceResult(p, after) {
    const S = p.writes.filter((x) => x.stamp).sort((a, b) => a.stampAt - b.stampAt || cmpStamp(a.stamp, b.stamp))
    const parts = [`Both wrote at ${esc(vt(p.at))} on the simulated clock.`]
    if (S.length === 2) {
      const [a, b] = S, cur = page.owner(ROW)
      if (a.stamp.origin === b.stamp.origin) {
        const o = a.stamp.origin, owns = uuidOf(o) === cur
        parts.push(`${nid(o, { owner: owns })} ${owns ? 'owns' : 'owned'} <code>counter</code> and stamped both, in turn.`)
      } else if (cmpStamp(b.stamp, a.stamp) > 0) {
        parts.push(`${nid(a.stamp.origin)} stamped one in view ${a.stamp.epoch}, then ${nid(b.stamp.origin)} stamped the other in view ${b.stamp.epoch}.`)
      } else {
        parts.push(`${nid(a.stamp.origin)} stamped one first, in view ${a.stamp.epoch}. ${nid(b.stamp.origin)} stamped the other later, but in its older view ${b.stamp.epoch}, so that stamp is smaller.`)
      }
      const top = cmpStamp(a.stamp, b.stamp) > 0 ? a : b, h = holding([top])
      parts.push(h.k === h.of ? `Every ${h.someDown ? 'live ' : ''}copy keeps the bigger stamp.` : `${fmt(h.k)} of ${fmt(h.of)} live copies hold the bigger stamp so far.`)
      parts.push(`Two adds, and the count went from ${fmt(p.before)} to ${fmt(after)}.`)
      if (2 - (after - p.before) > 0) parts.push(page.violations === 0 ? 'Both writes committed and no rule broke, so nothing reports it.' : 'Both writes committed.')
    } else if (S.length === 1) {
      const g = p.writes.find((x) => !x.stamp)
      parts.push(`${nid(S[0].node)}’s write committed; ${nid(g.node)}’s never did. One add, and the count went from ${fmt(p.before)} to ${fmt(after)}.`)
    } else parts.push('Neither write committed.')
    return parts.join(' ')
  }
  function rowsResult(p, after) {
    const S = p.writes.filter((x) => x.stamp)
    const parts = [`Both wrote at ${esc(vt(p.at))} on the simulated clock, each to a row of its own.`]
    if (S.length === 2) {
      const h = holding(S)
      parts.push(h.k === h.of ? `Every ${h.someDown ? 'live ' : ''}copy holds both.` : `${fmt(h.k)} of ${fmt(h.of)} live copies hold both so far.`)
      parts.push(`Two adds, and the rows went from ${fmt(p.before)} to ${fmt(after)}.`)
    } else if (S.length === 1) {
      const g = p.writes.find((x) => !x.stamp)
      parts.push(`${nid(S[0].node)}’s row committed; ${nid(g.node)}’s never did. One add, and the rows went from ${fmt(p.before)} to ${fmt(after)}.`)
    } else parts.push('Neither write committed.')
    return parts.join(' ')
  }
  function renderCases(force) {
    if (!force && (!onScreen || document.hidden)) return
    const ws = writers()
    for (const kind of ['race', 'rows']) {
      const c = cases[kind]
      const btn = $(`ct-${kind}-go`), why = blocked(c)
      btn.disabled = !!why
      btn.title = why || (kind === 'race' ? 'two servers read counter and write back one more, at the same simulated moment' : 'two servers each write a new row of their own')
      // every write this card posted counts once, the moment its own stamp is found
      for (const x of c.all) if (!x.stamp && !x.gone) fate(x)
      const adds = c.all.filter((x) => x.stamp).length
      const now = kind === 'race' ? newestCounter() : addRowsNow()
      const body = $(`ct-${kind}-body`)
      const copies = copiesHTML(c, kind)
      let html
      if (!c.pair) {
        // before the first press: the plan, with the servers that will do it, and what every copy holds now
        const [a, b] = ws ? [nid(ws[0]), nid(ws[1])] : ['', '']
        const note = why && why !== 'waiting for the last two writes' ? ` <span class="ct-dim">(${esc(why)})</span>` : ''
        const text = kind === 'race'
          ? (ws ? `The page reads ${a}’s copy and ${b}’s copy, then posts on each the record this line becomes, at the same simulated moment.` : 'The page reads two servers’ copies, then posts on each the record this line becomes, at the same simulated moment.')
          : (ws ? `The page posts on ${a} and on ${b} the record this line becomes, each to a new row named after that server (<code>me</code>).` : 'The page posts on two servers the record this line becomes, each to a new row named after that server (<code>me</code>).')
        html = `<p class="ct-hint">${text}${note}</p><div class="ct-copies">${copies.html}</div>`
      } else {
        const p = c.pair
        const settled = p.writes.every((x) => { const f = fate(x); return f === 'stamped' || f === 'gone' })
        // once settled, in the order the stamps were made; until then, in the order they were posted
        const order = settled ? p.writes.slice().sort((x, y) => (x.stamp ? 0 : 1) - (y.stamp ? 0 : 1) || x.stampAt - y.stampAt) : p.writes
        const lines = order.map(writeLine).join('')
        const result = settled ? (kind === 'race' ? raceResult(p, now) : rowsResult(p, now)) : ''
        html = `<div class="ct-writes">${lines}</div><div class="ct-copies">${copies.html}</div>${result ? `<p class="ct-result">${result}</p>` : ''}`
      }
      putHTML(body, html)
      // the waiting times: text only, inside the attested body
      if (c.pair) for (const x of c.pair.writes) { const t = body.querySelector(`.ct-wt[data-wid="${x.id}"]`); if (t) { const s = vt(page.now - x.w.issuedAt); if (t.textContent !== s) t.textContent = s } }
      if (!REDUCED) for (const key of copies.flash) { const el = body.querySelector(`[data-fk="${key}"]`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash') } }
      // the foot: adds that committed, the count (or rows) now, and the committed adds missing from it
      const start = c.start ?? now
      attest($(`ct-${kind}-adds`), adds, 'runtime')
      attest($(`ct-${kind}-count`), now, 'runtime')
      const lost = Math.max(0, adds - (now - start))
      attest($(`ct-${kind}-lost`), lost, 'runtime')
      $(`ct-${kind}-lost`).classList.toggle('ct-lost', lost > 0)
    }
  }
  const cmpStamp = (a, b) => a.epoch - b.epoch || a.seq - b.seq || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)
  const sameStamp = (a, b) => !!a && !!b && a.epoch === b.epoch && a.seq === b.seq && a.origin === b.origin

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // the clock: checkpoints always; DOM work and twin checks only while on screen, a few times a second
  let lastRender = 0
  page.on('tick', () => {
    checkpoint()
    if (!onScreen || document.hidden) return
    const t = performance.now()
    if (seen && !rp.busy && !rp.timer && t - rp.lastSend > RECHECK_MS) requestReplay()
    if (t - lastRender < 200) return
    lastRender = t
    renderRules()
    renderCases()
  })
  page.on('reset', () => {
    log.length = 0; lastCpAt = -Infinity; violShown = -1
    cases.race = fresh(); cases.rows = fresh(); stampedAt.clear()
    // the twin belongs to the old run: drop it at once, and say so until the new one reports
    clearTimeout(rp.timer)
    if (rp.worker) rp.worker.terminate()
    Object.assign(rp, { worker: null, id: rp.id + 1, busy: false, fresh: true, sentActs: 0, actsRef: null, lastAt: -1, lastSend: -Infinity, dead: false, timer: 0, snap: null })
    verdict.className = 'ct-verdict'
    putHTML(verdict, '<span class="ct-pending">rebuilding the twin…</span>')
    vsub.removeAttribute('data-attested'); vsub.innerHTML = SUB0; vsub.__html = SUB0
    attest($('ct-replay-own'), `own run · seed ${page.seed}`, 'runtime')
    renderRules(); renderCases(true)
    if (seen) scheduleReplay(800)
  })
  onSeen.push(() => { renderRules(); renderCases(true) })
  renderRules(); renderCases(true)
  window.__contract = { sweep: sw, replay: rp, cases, log, runSweep, requestReplay, renderRules, renderCases, fate }
}
