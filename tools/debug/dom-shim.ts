//! ── tools/debug/dom-shim — the dependency-free DOM harness both debugger pages are driven through ──
// Extracted from viewer.dom.test.ts so eli5.test.ts can sweep the SAME booted viewer for its glossary
// keys without a second copy of the shim (the dual-copy lesson). The rules are unchanged: string-sink
// elements (innerHTML/textContent are plain props), listeners are captured and FIRED through the
// registered path (never called directly), getElementById answers ONLY for ids the page's markup really
// has, and the script runs in strict mode. If a page grows a DOM API this shim lacks, its script throws at
// load and the suites fail loudly — extend the shim; never stub the assertion.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as MODEL from './model.mjs'
import * as ELI5 from './eli5.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

//! the DOM shim — string-sink elements: innerHTML/textContent are plain props, listeners are captured.
// Attributes live in a Map (the tooltip layer reads data-tip through getAttribute); appendChild records
// children (the layer mounts a <style> in head and the card in body); geometry is all zeros (a shim
// cannot prove pixels — it proves the strings the page would paint).
export const makeEl = (id: string) => {
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const set = new Set<string>()
  const attrs = new Map<string, string>()
  const el: any = {
    id, listeners, innerHTML: '', textContent: '', value: '', max: '', min: '', disabled: false,
    className: '', hidden: false, isConnected: true, children: [] as unknown[],
    dataset: {}, style: {} as Record<string, string>, files: [], offsetWidth: 0, offsetHeight: 0,
    classList: {
      add: (c: string) => set.add(c), remove: (c: string) => set.delete(c),
      toggle: (c: string, f?: boolean) => { (f ?? !set.has(c)) ? set.add(c) : set.delete(c) },
      contains: (c: string) => set.has(c),
    },
    setAttribute: (k: string, v: string) => { attrs.set(k, String(v)) },
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    hasAttribute: (k: string) => attrs.has(k),
    appendChild: (c: unknown) => { el.children.push(c); return c },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    contains: () => false,
    closest: () => null,
    addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn) },
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    // fire through the REGISTERED listeners — the same path a real event takes; a listener that
    // throws propagates and fails the test (no swallowing)
    fire(type: string, extra: Record<string, unknown> = {}) {
      const fns = listeners[type] ?? []
      assert.ok(fns.length > 0, `no '${type}' listener registered on #${id} — the wiring is gone`)
      for (const fn of fns) fn({ preventDefault() {}, stopPropagation() {}, target: el, ...extra })
    },
  }
  return el
}

//! a hoverable stand-in for a painted [data-tip] element: what the delegated mouseover's target.closest()
// returns. Only the attributes the layer reads exist on it — a shim element, not a parsed DOM.
export const tipTarget = (key: string, fact = '') => {
  const t: any = {
    isConnected: true,
    getAttribute: (k: string) => (k === 'data-tip' ? key : k === 'data-tip-fact' ? fact || null : null),
    getBoundingClientRect: () => ({ left: 40, top: 40, right: 80, bottom: 60, width: 40, height: 20 }),
  }
  t.closest = (sel: string) => (sel === '[data-tip]' ? t : null)
  return t
}

//! the shared document + window shim for one page boot. The window's timers run IMMEDIATELY: the tooltip
// layer's settle delay is a UX nicety, and a synchronous shim lets a test assert right after the hover.
const makeDocument = (realIds: Set<string>) => {
  const els = new Map<string, any>()
  const el = (id: string) => {
    if (!els.has(id)) {
      assert.ok(realIds.has(id), `the page script asked for #${id} which the markup does not have`)
      els.set(id, makeEl(id))
    }
    return els.get(id)
  }
  const body = makeEl('.body')
  const head = makeEl('<head>')
  const docListeners: Record<string, Array<(e: unknown) => void>> = {}
  const win = {
    innerWidth: 1280, innerHeight: 800,
    setTimeout: (fn: () => void) => { fn(); return 1 }, clearTimeout: () => {},
    addEventListener: () => {},
  }
  const document = {
    getElementById: (id: string) => (realIds.has(id) ? el(id) : null),
    querySelector: (sel: string) => (sel === '.body' ? body : null),
    createElement: (tag: string) => makeEl(`<${tag}>`),
    addEventListener: (t: string, fn: (e: unknown) => void) => { (docListeners[t] ??= []).push(fn) },
    activeElement: null as unknown,
    head, body, defaultView: win,
  }
  //! fireDoc — drive a DOCUMENT-level delegated listener (the tooltip layer, the .ref nav handler)
  const fireDoc = (type: string, e: Record<string, unknown>) => {
    const fns = docListeners[type] ?? []
    assert.ok(fns.length > 0, `no '${type}' listener registered on document — the wiring is gone`)
    for (const fn of fns) fn({ preventDefault() {}, stopPropagation() {}, ...e })
  }
  //! hover(key) — a mouseover whose target sits inside a painted [data-tip="key"]; hover(null) leaves onto plain chrome
  const hover = (key: string | null, fact = '') =>
    fireDoc('mouseover', { target: key == null ? { closest: () => null } : { closest: (sel: string) => (sel === '[data-tip]' ? tipTarget(key, fact) : null) } })
  return { document, docListeners, el, fireDoc, hover }
}

//! the inline module of a page, with its ESM imports rewired onto the SAME module objects Node imported
// (the browser loads ./model.mjs + ./eli5.mjs; a vm Script cannot, so the bindings are injected as globals)
const pageScript = (file: string) => {
  const html = readFileSync(join(HERE, file), 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, `${file} has one inline module script`)
  const markup = html.slice(0, html.indexOf('<script type="module">'))
  const realIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]))
  const page = {
    src: m![1], realIds,
    rewire(mod: string, global: string) {
      const re = new RegExp(`^import\\s+\\{([^}]+)\\}\\s+from\\s+'\\./${mod}\\.mjs';?`, 'm')
      assert.ok(re.test(page.src), `${file} imports ./${mod}.mjs`)
      page.src = page.src.replace(re, `const {$1} = ${global};`)
      assert.ok(!re.test(page.src), `the ${mod} import was rewired`)
    },
  }
  return page
}

//! boot the real viewer script against one capture; returns the live vm context + elements.
// `search` is the deep-link query (default ?scenario=<id>); a '' search boots the /capture.json path
// (live captures poll — setInterval is a stub, so the poll never ticks; the test drives repaints itself).
// `fetch` replaces the one-answer stub with the test's own (a source that is absent, then present); the
// page's setTimeout is CAPTURED into `timers` (never run), so a test fires a scheduled retry by hand.
export const bootViewer = async (
  scenarioId: string, capture: unknown,
  opts: { failFetch?: boolean; search?: string; fetch?: (url: string) => Promise<unknown> } = {},
) => {
  const page = pageScript('viewer.html')
  page.rewire('model', '__MODEL__')
  page.rewire('eli5', '__ELI5__')
  const dom = makeDocument(page.realIds)
  const wire = JSON.parse(JSON.stringify(capture)) // exactly what the HTTP route would serve
  const timers: { fn: () => void; ms: number }[] = []
  const ctx = vm.createContext({
    document: dom.document, docListeners: dom.docListeners,
    location: { search: opts.search ?? `?scenario=${scenarioId}`, pathname: '/debug' },
    history: { replaceState() {} },
    getSelection: () => ({ isCollapsed: true }),
    fetch: opts.fetch ?? (async () => (opts.failFetch ? { ok: false, status: 503 } : { ok: true, json: async () => wire })),
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: () => {},
    URLSearchParams, console,
    __MODEL__: MODEL, __ELI5__: ELI5,
  })
  vm.runInContext(`'use strict';\n${page.src}`, ctx, { filename: 'viewer.html<script>' })
  // the boot awaits the fetch stub — pump microtasks until it settles either way
  const g = (expr: string) => vm.runInContext(expr, ctx)
  const { el } = dom
  for (let i = 0; i < 20 && !g('CAP != null') && !el('tree').innerHTML; i++)
    await new Promise((r) => setImmediate(r))
  if (!opts.failFetch && !opts.fetch) {
    assert.ok(g('CAP != null'), 'boot loaded the capture')
    assert.ok(!el('tree').innerHTML.includes("Couldn't load"), 'boot did not fall into the error pane')
  }
  return { el, g, timers, docListeners: dom.docListeners, fireDoc: dom.fireDoc, hover: dom.hover, document: dom.document }
}

//! drive one scrub through the trange 'input' listener — the exact drag path
export const dragTo = (el: (id: string) => any, t: number) => {
  el('trange').value = String(t)
  el('trange').fire('input')
}

//! boot the dashboard's inline module WITHOUT a document (its typeof-document guard keeps DOM wiring
// inert) and hand back the pure helpers, exactly as scenarios.html's header promises a harness can.
export const bootScenariosPure = () => {
  const page = pageScript('scenarios.html')
  page.rewire('eli5', '__ELI5__')
  const ctx = vm.createContext({ __ELI5__: ELI5 })
  //! const/let bindings stay script-scoped, so the export hook rides the SAME evaluation
  vm.runInContext(`${page.src}\n;this.__H__ = { esc, rel, fmtDelta, diagram, cardHTML, tallyHTML }`, ctx, { filename: 'scenarios.html#module' })
  return (ctx as { __H__: Record<string, (...a: never[]) => string> }).__H__
}

//! boot the dashboard WITH a document: the fetch → render path, so the painted tally + grid can be swept
export const bootScenarios = async (payload: unknown) => {
  const page = pageScript('scenarios.html')
  page.rewire('eli5', '__ELI5__')
  const dom = makeDocument(page.realIds)
  const ctx = vm.createContext({
    document: dom.document,
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payload)) }),
    Date, console, __ELI5__: ELI5,
  })
  vm.runInContext(`'use strict';\n${page.src}`, ctx, { filename: 'scenarios.html<script>' })
  const { el } = dom
  for (let i = 0; i < 20 && !el('grid').innerHTML; i++) await new Promise((r) => setImmediate(r))
  assert.ok(el('grid').innerHTML, 'the dashboard painted its grid')
  return { el, hover: dom.hover, fireDoc: dom.fireDoc, document: dom.document }
}
