// Claim 13 in a browser: the link mechanism of proto/lens.mjs (Link: a WeakRef to the target, a
// FinalizationRegistry entry, and the target checked before every delivery), copied here without data so the
// page needs no bundle. 1,000 DOM nodes are connected, then removed from the page and dropped by the program.
// mode idle: nothing runs; busy: allocation and DOM churn every 10 ms; busy-writes: the same plus one commit
// every 10 ms delivered to every live link (so the check can end a link before any finalizer).
window.runLinks = async function (mode, marksMs) {
  const ends = []
  let t0 = 0
  const links = []
  const reg = new FinalizationRegistry((link) => link.end('collected'))
  class Link {
    constructor(target, fn) { this.ref = new WeakRef(target); this.fn = fn; this.dead = false; reg.register(target, this) }
    feed(c) { if (this.dead) return; const t = this.ref.deref(); if (t === undefined) { this.end('check'); return } this.fn(t, c) }
    end(why) { if (this.dead) return; this.dead = true; this.fn = null; ends.push({ ms: performance.now() - t0, why }) }
  }
  let box = document.createElement('div')
  document.body.appendChild(box)
  for (let i = 0; i < 1000; i++) {
    const el = document.createElement('span'); el.textContent = 'row ' + i; box.appendChild(el)
    links.push(new Link(el, (el, c) => { el.textContent = 'v' + c })) // the function uses its argument only
  }
  await new Promise((r) => setTimeout(r, 50))
  box.remove(); box = null // removed by other code; nothing names the nodes now but the links' WeakRefs
  t0 = performance.now()
  let junk = [], seq = 0
  const tick = () => {
    if (mode !== 'idle') { junk = []; for (let i = 0; i < 2000; i++) junk.push({ a: i, b: 'x' + i }); const d = document.createElement('div'); d.innerHTML = '<p>churn</p>'.repeat(20); document.body.appendChild(d); d.remove() }
    if (mode === 'busy-writes') { seq++; for (const l of links) l.feed(seq) }
  }
  const marks = {}
  for (const at of marksMs) {
    while (performance.now() - t0 < at) { tick(); await new Promise((r) => setTimeout(r, 10)) }
    marks[at] = ends.length
  }
  const ms = ends.map((e) => e.ms).sort((a, b) => a - b)
  const q = (f) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]) : null)
  const why = {}; for (const e of ends) why[e.why] = (why[e.why] ?? 0) + 1
  return { mode, links: 1000, endedBy: marks, never: 1000 - ends.length, firstMs: ms.length ? Math.round(ms[0]) : null, p50Ms: q(0.5), p99Ms: q(0.99), why }
}
