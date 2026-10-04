/* variants.js — prototype-only. Every section that offers options wraps them:
     <div class="opt" data-section="race">
       <div data-variant="a" data-label="nine engines">…</div>
       <div data-variant="b" data-label="one engine · two workloads">…</div>
     </div>
   ?race=b picks a variant at load; the bottom-right bar switches live and keeps
   the URL in sync (so the picks can be copied as a link). ?all=1 shows every
   variant stacked with a ribbon; ?bar=0 hides the bar (clean screenshots).
   On a switch, the shown variant's root gets a 'variantshow' event and the
   hidden one 'varianthide' — section scripts should pause loops while hidden. */
(() => {
  const url = new URL(location.href)
  const all = url.searchParams.get('all') === '1'
  // hidden unless asked for: ?bar=1, or #options where a query string cannot reach the page (a hosted preview)
  const showBar = url.searchParams.get('bar') === '1' || location.hash === '#options'
  // the variant a section shows when the URL says nothing (the first variant otherwise)
  const DEFAULTS = {}
  // fero: the accent is a page-wide option — ?accent=<name> sets <html data-accent>; fero.css holds the values
  const ACCENTS = ['violet', 'cyan', 'magenta']
  const ACCENT_DEFAULT = 'violet'
  const accent = ACCENTS.includes(url.searchParams.get('accent')) ? url.searchParams.get('accent') : ACCENT_DEFAULT
  document.documentElement.dataset.accent = accent
  if (all) document.documentElement.classList.add('opt-all')
  const groups = [...document.querySelectorAll('.opt[data-section]')]
  const state = {}
  const replace = (u) => { try { history.replaceState(null, '', u) } catch { /* a sandboxed frame: the picks stay in the page */ } }
  const fire = (el, type) => el.dispatchEvent(new CustomEvent(type, { bubbles: false }))
  function apply(section, v, initial) {
    const g = groups.find(x => x.dataset.section === section)
    if (!g) return
    state[section] = v
    for (const el of g.querySelectorAll(':scope > [data-variant]')) {
      const on = all || el.dataset.variant === v
      const was = !el.hidden
      el.hidden = !on
      if (on && (!was || initial)) fire(el, 'variantshow')
      if (!on && was) fire(el, 'varianthide')
    }
    if (!initial) {
      const u = new URL(location.href)
      const first = DEFAULTS[section] || g.querySelector(':scope > [data-variant]')?.dataset.variant
      if (v === first) u.searchParams.delete(section); else u.searchParams.set(section, v)
      replace(u)
    }
    document.querySelectorAll(`#optbar button[data-s="${section}"]`).forEach(b => b.classList.toggle('on', b.dataset.v === v))
  }
  for (const g of groups) {
    const vs = [...g.querySelectorAll(':scope > [data-variant]')]
    for (const el of vs) {
      if (!el.querySelector(':scope > .opt-ribbon')) {
        const r = document.createElement('span'); r.className = 'opt-ribbon'
        r.textContent = `${g.dataset.section} · ${el.dataset.variant} · ${el.dataset.label || ''}`
        el.prepend(r)
      }
    }
    const want = url.searchParams.get(g.dataset.section) || DEFAULTS[g.dataset.section]
    const v = vs.some(x => x.dataset.variant === want) ? want : vs[0]?.dataset.variant
    if (v) apply(g.dataset.section, v, true)
    g.classList.add('opt-ready')
  }
  const bar = document.createElement('div'); bar.id = 'optbar'
  bar.hidden = !showBar
  // the mark (∴ = "three members plus dir", the README's deployment rule; = = plain assignment; none)
  const MARKS = { dots: '∴', eq: '=', none: '' }
  const markQ = url.searchParams.get('mark')
  const setMark = (m) => { const b = document.querySelector('.masthead .mark b'); if (b) { b.textContent = MARKS[m]; b.hidden = !MARKS[m] } }
  if (markQ in MARKS) setMark(markQ)
  { // the mark row
    const row = document.createElement('div'); row.className = 'row'
    const b = document.createElement('b'); b.textContent = 'mark'; row.append(b)
    for (const [m, glyph] of Object.entries(MARKS)) {
      const btn = document.createElement('button'); btn.textContent = glyph || 'none'; btn.dataset.mark = m
      btn.classList.toggle('on', (markQ in MARKS ? markQ : 'dots') === m)
      btn.addEventListener('click', () => {
        setMark(m); bar.querySelectorAll('button[data-mark]').forEach((x) => x.classList.toggle('on', x === btn))
        const u = new URL(location.href); if (m === 'dots') u.searchParams.delete('mark'); else u.searchParams.set('mark', m); replace(u)
      })
      row.append(btn)
    }
    bar.append(row)
  }
  { // the accent row
    const row = document.createElement('div'); row.className = 'row'
    const b = document.createElement('b'); b.textContent = 'accent'; row.append(b)
    for (const a of ACCENTS) {
      const btn = document.createElement('button'); btn.textContent = a; btn.dataset.accent = a
      btn.classList.toggle('on', a === accent)
      btn.addEventListener('click', () => {
        document.documentElement.dataset.accent = a
        bar.querySelectorAll('button[data-accent]').forEach((x) => x.classList.toggle('on', x === btn))
        const u = new URL(location.href); if (a === ACCENT_DEFAULT) u.searchParams.delete('accent'); else u.searchParams.set('accent', a); replace(u)
        window.dispatchEvent(new CustomEvent('accentchange', { detail: a }))
      })
      row.append(btn)
    }
    bar.append(row)
  }
  const hint = document.createElement('div'); hint.className = 'hint'
  for (const g of groups) {
    const row = document.createElement('div'); row.className = 'row'
    const b = document.createElement('b'); b.textContent = g.dataset.section; row.append(b)
    for (const el of g.querySelectorAll(':scope > [data-variant]')) {
      const btn = document.createElement('button')
      btn.dataset.s = g.dataset.section; btn.dataset.v = el.dataset.variant
      btn.textContent = el.dataset.variant.toUpperCase()
      btn.title = el.dataset.label || ''
      btn.classList.toggle('on', state[g.dataset.section] === el.dataset.variant)
      btn.addEventListener('click', () => apply(g.dataset.section, el.dataset.variant, false))
      row.append(btn)
    }
    // the variant's name shows in the bar's one hint line, never inside the row: a row that grew would slide the
    // button out from under the pointer
    row.addEventListener('mouseover', (e) => { if (e.target.tagName === 'BUTTON') hint.textContent = `${g.dataset.section} ${e.target.textContent}: ${e.target.title}` })
    row.addEventListener('mouseout', () => { hint.textContent = '' })
    bar.append(row)
  }
  bar.append(hint)
  const foot = document.createElement('div'); foot.className = 'foot'
  const copy = document.createElement('a'); copy.textContent = 'copy picks'
  copy.addEventListener('click', () => { navigator.clipboard?.writeText(location.href).then(() => { copy.textContent = 'copied'; setTimeout(() => copy.textContent = 'copy picks', 1200) }, () => {}) })
  const allA = document.createElement('a'); allA.textContent = all ? 'one at a time' : 'show all'
  allA.addEventListener('click', () => { const u = new URL(location.href); if (all) u.searchParams.delete('all'); else u.searchParams.set('all', '1'); location.href = u })
  const hide = document.createElement('a'); hide.textContent = 'hide'
  hide.addEventListener('click', () => { bar.hidden = true })
  // in a frame (a hosted preview) the host passes no query string to the page, so a copied link could not bring the
  // picks back, and the frame may have no clipboard: no 'copy picks' there
  let framed = true; try { framed = window.top !== window } catch { /* a cross-origin parent: framed */ }
  foot.append(...(framed ? [] : [copy]), allA, hide)
  bar.append(foot)
  document.body.append(bar)
  window.__variants = { state, apply }
})()
