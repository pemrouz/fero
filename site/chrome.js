// chrome.js — page furniture: the footer's build line, and in-page jumps that land where they point.
import { attest } from './cluster.js'

// the footer: the commit the kernel cone was stripped from, and its module count and size from lib/manifest.json
// (strip.mjs's own list: a file that a Worker fetches again is not counted twice)
fetch('./lib/manifest.json').then((r) => r.json()).then((m) => {
  attest(document.querySelector('#head'), m.head, 'build')
  if (Array.isArray(m.modules)) attest(document.querySelector('#mods'), m.modules.length, 'build')
  if (m.bytes > 0) attest(document.querySelector('#kb'), Math.round(m.bytes / 1024), 'build')
}).catch(() => {})

// links to the data site wait until its fero card is fixed (CONCEPT §0, question 4): data/lede/links.json (BUILD:
// tools/lede-links.mjs) checks that site for CONCEPT §8's claims about fero. Until it says ok, the footer says "built on
// data" in plain words and 07's card shows no link; the lede holds back its own link the same way (sections/lede.js).
// The links open in a new tab, so a click never unloads this page and its live cluster.
fetch('./data/lede/links.json').then((r) => (r.ok ? r.json() : null)).then((l) => {
  if (l?.data?.ok !== true) return
  for (const el of document.querySelectorAll('.data-site')) el.hidden = false
  for (const el of document.querySelectorAll('.data-site-held')) el.hidden = true
}).catch(() => {})

// in-page jumps: the browser jumps first, then the sections above the target build their content (on a phone the
// centrepiece and 02 grow by hundreds of px as the jump passes them), and the target slides down out of view. So after
// a jump (a click on a #link, or a load with a hash) keep the target at the top while <main> changes size, until the
// reader scrolls, taps or presses a key, or six seconds pass (a section can settle a few seconds after load).
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
