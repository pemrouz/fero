// chrome.js — page furniture: the footer's build line, copy buttons, and in-page jumps that land where they point.
import { attest } from './cluster.js'

// the footer: the commit the kernel cone was stripped from, and its module count and size from lib/manifest.json
// (strip.mjs's own list), and the package version from data/manifest.json (tools/manifest.mjs: package.json)
fetch('./lib/manifest.json').then((r) => r.json()).then((m) => {
  // the commit the kernel was stripped from: a tooltip on the line, not text on the page (no hex on the main path)
  const line = document.querySelector('#engine-line'); if (line && m.head) line.title = 'kernel stripped from fero at commit ' + m.head
  if (Array.isArray(m.modules)) attest(document.querySelector('#mods'), m.modules.length, 'build')
  if (m.bytes > 0) attest(document.querySelector('#kb'), Math.round(m.bytes / 1024), 'build')
}).catch(() => {})
fetch('./data/manifest.json').then((r) => r.json()).then((m) => {
  if (m.version) attest(document.querySelector('#foot-version'), m.version, 'build')
}).catch(() => {})

// copy buttons: <button data-copy="npm i fero">copy</button> copies its text and says so for a moment (to a screen
// reader too). Where the clipboard is refused, the text is selected so the reader can copy it by hand. A button that
// sits away from its text names it: data-copy-from="<id>" (what to select) and data-copy-name (what to say aloud,
// e.g. a file's name rather than the whole file).
const announce = (s) => { const a = document.querySelector('#announce'); if (a) { a.textContent = ''; requestAnimationFrame(() => { a.textContent = s }) } }
function selectFor(b) {
  const from = b.getAttribute('data-copy-from')
  const target = (from && document.getElementById(from)) || b.closest('.install')?.querySelector('.cmd, code') || b.closest('.install') || b.parentElement
  if (!target) return
  const r = document.createRange(); r.selectNodeContents(target)
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button[data-copy]')
  if (!b) return
  const text = b.getAttribute('data-copy'), was = b.textContent
  const done = (ok) => {
    if (!ok) selectFor(b)
    b.textContent = ok ? 'copied' : 'select it'
    announce(ok ? 'Copied: ' + (b.getAttribute('data-copy-name') ?? text) : 'Selected. Copy it with your keyboard.')
    setTimeout(() => { b.textContent = was }, 1400)
  }
  try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)) } catch { done(false) }
})

// in-page jumps: the browser jumps first, then the sections above the target build their content (the live cluster
// and the story grow as the jump passes them), and the target slides down out of view. So after a jump (a click on a
// #link, or a load with a hash) keep the target at the top while <main> changes size, until the reader scrolls, taps
// or presses a key, or six seconds pass.
let release = null
function land(id) {
  const el = id && document.getElementById(id), main = document.querySelector('main')
  if (!el || !main || typeof ResizeObserver !== 'function') return
  release?.()
  const own = ['wheel', 'touchstart', 'keydown', 'pointerdown']
  const stop = () => { ro.disconnect(); clearTimeout(cap); for (const t of own) removeEventListener(t, stop, true); release = null }
  const ro = new ResizeObserver(() => el.scrollIntoView({ block: 'start' }))
  const cap = setTimeout(stop, 6000)
  for (const t of own) addEventListener(t, stop, { capture: true, passive: true })
  ro.observe(main)
  release = stop
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#"]')
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const id = decodeURIComponent(a.getAttribute('href').slice(1))
  if (id) requestAnimationFrame(() => land(id))
})
if (location.hash.length > 1) land(decodeURIComponent(location.hash.slice(1)))
