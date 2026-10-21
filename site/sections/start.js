// sections/start.js — 03 Start: two files, each over the screen it printed in a real run. Nothing here is live: no
// cluster, no timers. Where everything comes from:
//   the code blocks ← examples/cafe.ts and examples/visitor.ts, byte for byte (tests/start.drive.mjs compares them)
//   the screens     ← data/start/recording.json, every line as printed (data/start/record.mjs made it)
//   the numbers     ← data/manifest.json (BUILD): the Node floor and the example count; the door's run details from
//                     the recording (BUILD)
import { attest } from '../cluster.js'

const root = document.getElementById('start')
const $ = (sel) => root.querySelector(sel)
const get = (url, as) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r[as]() })
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ROLES = ['cafe', 'visitor']

// the owner's style, lightly painted: comments faint, strings green, fero violet, and the value a write sets violet
const TOKEN = /(\/\/.*$)|('(?:[^'\\]|\\.)*')|\b(fero)\b/g
const tokens = (s) => {
  let out = '', last = 0
  for (const m of s.matchAll(TOKEN)) {
    out += esc(s.slice(last, m.index)) + `<span class="${m[1] ? 'c' : m[2] ? 's' : 'f'}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last))
}
const ASSIGN = /^(\s*\w+\.data\.(\w+) = )(.+?)\s*$/ // `cafe.data.biscuit = { mood: 'purring' }`: a write
const paint = (line) => { const w = ASSIGN.exec(line); return w ? tokens(w[1]) + `<span class="w">${esc(w[3])}</span>` : tokens(line) }

// one block per line, each ending in its own newline, so the text is the file's exact bytes. A line too long for a
// phone wraps under itself: a wrapped part of code or of a printed line hangs DEEP, 6 characters in from its own
// line, past the next indent level (code steps by 4, Node's objects by 2), so it never reads as a line of its own;
// a comment's wrapped part sits under its words (3), in the comment's faint colour
const HANG = 6, UNDER_WORDS = 3
const hang = (l, extra) => `style="--hang:${l.length - l.trimStart().length + extra}ch"`
const block = (text, each) => {
  const lines = text.split('\n'), end = text.endsWith('\n')
  if (end) lines.pop()
  return lines.map((l, i) => `<span class="l" ${hang(l, l.trimStart().startsWith('//') ? UNDER_WORDS : HANG)}>${each(l)}${end || i < lines.length - 1 ? '\n' : ''}</span>`).join('')
}

// a screen: the lines as printed; the line that shows the visitor's write is violet
const screen = (lines, needle) => lines.map((l) => {
  const i = needle ? l.indexOf(needle) : -1
  const html = i < 0 ? esc(l) : esc(l.slice(0, i)) + `<span class="w">${esc(needle)}</span>` + esc(l.slice(i + needle.length))
  return `<span class="l${i < 0 ? '' : ' has-w'}" ${hang(l, HANG)}>${html}\n</span>`
}).join('')

const files = Promise.all(ROLES.map((r) => get(`./examples/${r}.ts`, 'text')))
const rec = get('./data/start/recording.json', 'json')

files.then((srcs) => ROLES.forEach((r, i) => {
  const pre = $(`pre[data-file="${r}.ts"]`), copy = $(`[data-role="${r}"] .st-copy`)
  pre.innerHTML = block(srcs[i], paint)
  copy.setAttribute('data-copy', srcs[i]); copy.disabled = false
})).catch((e) => { console.error('start: the two files did not load', e); for (const p of root.querySelectorAll('pre[data-file]')) p.textContent = 'This file did not load.' })

Promise.all([files, rec]).then(([srcs, r]) => {
  // the visitor's write, read from its own file, is the line each screen prints for it: `biscuit: { mood: 'purring' }`
  const w = srcs.map((s) => s.split('\n').map((l) => ASSIGN.exec(l)).find(Boolean)).find(Boolean)
  const needle = w ? `${w[2]}: ${w[3]}` : null
  for (const role of ROLES) {
    $(`[data-screen="${role}"]`).innerHTML = screen(r[role], needle)
    const cmd = $(`[data-role="${role}"] .st-cmd`)
    cmd.textContent = `$ ${r.shown[role]}`
    cmd.title = `recorded as: ${r.commands[role]}`
  }
  // the door: when, on what, and the exact commands (a private directory port; the config layer off)
  const day = new Date(r.recordedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  attest($('[data-st="when"]'), day, 'build')
  attest($('[data-st="nodeRun"]'), r.node.replace(/^v/, ''), 'build')
  attest($('[data-st="fero"]'), r.fero.version, 'build')
  for (const role of ROLES) attest($(`[data-st="cmd-${role}"]`), r.commands[role], 'build')
}).catch((e) => { console.error('start: the recording did not load', e) })

// BUILD: the Node floor (package.json engines) and the example count (the rung folders), from the dated manifest
get('./data/manifest.json', 'json').then((m) => {
  if (m.node) attest($('[data-st="node"]'), m.node, 'build')
  if (Array.isArray(m.examples)) attest($('[data-st="examples"]'), m.examples.length, 'build')
}).catch((e) => { console.error('start: the manifest did not load', e) })
