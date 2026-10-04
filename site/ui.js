// ui.js — the shared way the page SHOWS fero's real objects, so every section draws a record, a stamp,
// a node id and a node's object the same way. Pure functions that return HTML strings (escape-safe).
//   import { nid, stamp, rec, inspect, vt, esc } from '../ui.js'
import { label } from './core.js'

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// nid('n02', { owner }) → the id in mono, plain ink (colour means state, never identity); a violet ★ marks an owner
export const nid = (id, { owner = false, text = id } = {}) => `<span class="nid${owner ? ' owner' : ''}" data-node="${esc(id)}" title="${esc(label(id))}">${esc(text)}</span>`

// stamp({ epoch, seq, origin }) → "view 1 · #3 · n02": the view it was stamped in, the owner's counter, the owner.
// Records sort by it; a cell keeps the record with the biggest stamp.
export const stamp = (s) => s
  ? `<span class="stamp" data-node="${esc(s.origin)}" title="the stamp: view ${s.epoch}, counter ${s.seq}, stamped by ${esc(s.origin)} — records sort by it, and a copy keeps the biggest">view ${s.epoch} · #${s.seq} · <span class="o">${esc(s.origin)}</span></span>`
  : `<span class="stamp">unstamped</span>`

// rec({ type, key, value, at }) → the record exactly as the kernel carries it (kernel/env.ts Rec): the type is the
// number (0 update · 1 insert · 2 remove), with its name on hover — show the real object, never a gloss of it
const TYPE = ['update', 'insert', 'remove']
// each `key: value` part of a record stays on one line when it is short, so a record that wraps breaks between its
// parts, never inside `{ stock: 4 }`; a long part may still wrap
const part = (html) => (html.replace(/<[^>]+>/g, '').length <= 40 ? `<span class="rf">${html}</span>` : html)
export const rec = (r) => {
  const parts = [`<span class="k">type</span><span class="p">:</span> <span class="n" title="${TYPE[r.type] ?? r.type}">${esc(r.type)}</span>`,
    `<span class="k">key</span><span class="p">:</span> <span class="p">[</span>${r.key.map((k) => `<span class="s">'${esc(k)}'</span>`).join('<span class="p">, </span>')}<span class="p">]</span>`]
  if (r.type !== 2) parts.push(`<span class="k">value</span><span class="p">:</span> ${inspect(r.value)}`)
  if (r.at !== undefined) parts.push(`<span class="k">at</span><span class="p">:</span> <span class="s">'${esc(r.at)}'</span>`)
  return `<span class="rec"><span class="p">{ </span>${parts.map(part).join('<span class="p">, </span>')}<span class="p"> }</span></span>`
}

// inspect(value) → Node's util.inspect look, as the examples print `console.log(shop.snapshot)`:
// unquoted identifier keys, single-quoted strings and odd keys, `{ a: 1 }` spacing. One line.
const IDENT = /^[A-Za-z_$][\w$]*$/
export function inspect(v) {
  if (v === undefined) return '<span class="p">undefined</span>'
  if (v === null) return '<span class="p">null</span>'
  if (typeof v === 'string') return `<span class="s">'${esc(v)}'</span>`
  if (typeof v === 'number' || typeof v === 'boolean') return `<span class="n">${esc(String(v))}</span>`
  if (Array.isArray(v)) return `<span class="p">[ </span>${v.map(inspect).join('<span class="p">, </span>')}<span class="p"> ]</span>`
  if (v instanceof Uint8Array) return `<span class="p">Uint8Array(${v.length})</span>`
  const ks = Object.keys(v)
  if (!ks.length) return '<span class="p">{}</span>'
  return `<span class="p">{ </span>${ks.map((k) => `<span class="k">${IDENT.test(k) ? esc(k) : `'${esc(k)}'`}</span><span class="p">: </span>${inspect(v[k])}`).join('<span class="p">, </span>')}<span class="p"> }</span>`
}

// vt(ms) → simulated-clock time, labelled as such by the caller ("4.7 s on the simulated clock")
export const vt = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
