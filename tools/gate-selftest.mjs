#!/usr/bin/env node
// Checks the gate itself. Run: node tools/gate-selftest.mjs
// It copies spec/ to a temp folder, breaks the copy in one way at a time, and checks that the gate fails each time,
// and that it passes the unbroken copy. It ends "ok gate-selftest" or names the breaks the gate let through.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root } from './ledger-lib.mjs'

const src = path.join(root, 'spec')
const run = (tool, dir) => spawnSync(process.execPath, [path.join(root, 'tools', tool)], { env: { ...process.env, FERO_SPEC_DIR: dir }, encoding: 'utf8' })
const edit = (dir, file, fn) => { const f = path.join(dir, file); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))) }
const json = (dir, file, fn) => edit(dir, file, t => { const v = JSON.parse(t); const out = fn(v); return JSON.stringify(out === undefined ? v : out) })
const first = (v, id) => v.find(r => r.id === id)

// Each break: a name, and what it does to the copy. The gate must fail on every one.
const breaks = [
  ['an id repeats', d => json(d, 'ledger.json', v => { v[1].id = v[0].id })],
  ['a bad layer', d => json(d, 'ledger.json', v => { v[0].layer = 'L9' })],
  ['low over high', d => json(d, 'ledger.json', v => { v[0].low = 5 })],
  ['a null record', d => json(d, 'ledger.json', v => { v[3] = null })],
  ['a text of three sentences', d => json(d, 'ledger.json', v => { v[0].text = 'One rule. And a second rule. And a third.' })],
  ['a proof claimed with typed sites and tests', d => json(d, 'ledger.json', v => { v[0].proof = 'switch'; v[0].sites = ['x']; v[0].tests = ['y'] })],
  ['known by model with no experiment named', d => json(d, 'ledger.json', v => { const r = v.find(r => r.known === 'model'); r.evidence = 'trust me' })],
  ['low 0 that names no record', d => json(d, 'ledger.json', v => { v[0].low = 0 })],
  ['low 0 that names a record that does not exist', d => json(d, 'ledger.json', v => { v[0].low = 0; v[0].evidence = 'may fold into no-such.1' })],
  ['a retired id used again', d => json(d, 'ledger.json', v => { const gone = JSON.parse(fs.readFileSync(path.join(d, 'retired.json'), 'utf8'))[0]; const r = v.find(r => r.id.startsWith(gone.replace(/\.\d+$/, '.'))); r.id = gone })],
  ['a number skipped and not retired', d => json(d, 'retired.json', v => v.slice(1))],
  ['an id shared with later.json', d => json(d, 'later.json', v => { v[0].id = JSON.parse(fs.readFileSync(path.join(d, 'ledger.json'), 'utf8'))[0].id })],
  ['budget.json deleted', d => fs.rmSync(path.join(d, 'budget.json'))],
  ['slices.json deleted', d => fs.rmSync(path.join(d, 'slices.json'))],
  ['retired.json deleted', d => fs.rmSync(path.join(d, 'retired.json'))],
  ['the budget raised alone', d => json(d, 'budget.json', v => { v.total = 9999; v.status = `accepted by card ${v.card}` })],
  ['the budget raised with its card line, while the card is open', d => { json(d, 'budget.json', v => { v.total = 9999 }); edit(d, 'cards/0001-budget.md', t => t.replace(/\| whole \d+ \|/, '| whole 9999 |')) }],
  ['headroom of 500 %', d => json(d, 'budget.json', v => { v.headroom_pct = 500 })],
  ['the budget names no card', d => json(d, 'budget.json', v => { delete v.card })],
  ['the budget names a card that is not there', d => json(d, 'budget.json', v => { v.card = '0042'; v.status = 'accepted by card 0042' })],
  ['a layer over its budget', d => json(d, 'ledger.json', v => { const r = v[0], add = []; for (let i = 0; i < 20; i++) add.push({ ...r, id: `batch-checksum.${i + 2}`, text: `Planted rule number ${i}.` }); v.splice(1, 0, ...add) })],
  ['slices.json out of step', d => json(d, 'slices.json', v => { v[1].rules.records++ })],
  ['slices.json names a data 5 mechanism its slice does not turn on', d => json(d, 'slices.json', v => { v[6].data5 = ['data-lane'] })],
  ["SYSTEM.md's count changed", d => edit(d, 'SYSTEM.md', t => t.replace(/ledger holds [0-9,]+ rule records/, 'ledger holds 500 rule records'))],
  ["SYSTEM.md's count sentence reworded away", d => edit(d, 'SYSTEM.md', t => t.replace('The ledger holds', 'The ledger has'))],
  ["SYSTEM.md's Raft count changed", d => edit(d, 'SYSTEM.md', t => t.replace(/carries \d+ of/, 'carries 63 of'))],
  ["README's line of counts by layer removed", d => edit(d, 'README.md', t => t.replace(/^Records by layer:.*$/m, ''))],
  ["README's count by slice changed", d => edit(d, 'README.md', t => t.replace(/S1 \d+/, 'S1 1'))],
  ["the open card's picture changed", d => edit(d, 'cards/0001-budget.md', t => t.replace(/^(L1 the log.*)\d{3}$/m, '$1999'))],
  ['a page names an unknown rule id', d => edit(d, 'NOTES.md', t => t + '\n`no-such-rule.7`\n')],
  ['a Raft port rule moved out of slice 1', d => json(d, 'ledger.json', v => { first(v, 'raft-log.1').slice = 2 })],
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-selftest-'))
const missed = []
try {
  const clean = path.join(tmp, 'clean'); fs.cpSync(src, clean, { recursive: true })
  if (run('ledger-gate.mjs', clean).status !== 0) missed.push('the unbroken copy does not pass the gate')
  if (run('grid.mjs', clean).status !== 0) missed.push('the unbroken copy does not pass the grid')
  breaks.forEach(([name, fn], i) => {
    const dir = path.join(tmp, 'b' + i); fs.cpSync(src, dir, { recursive: true })
    fn(dir)
    const r = run('ledger-gate.mjs', dir)
    if (r.status !== 1 || !/FAILED: \d+ problem/.test(r.stdout)) missed.push(`${name} (the gate ended ${r.status})`)
  })
  // The grid never shows a broken ledger as sound.
  const dir = path.join(tmp, 'grid'); fs.cpSync(src, dir, { recursive: true }); json(dir, 'ledger.json', v => { v[3] = null })
  const g = run('grid.mjs', dir)
  if (g.status !== 1 || !/gate: FAILED/.test(g.stdout)) missed.push(`the grid on a broken ledger (it ended ${g.status})`)
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }

if (missed.length) { console.log(`FAILED: the gate let ${missed.length} through`); for (const m of missed) console.log('  - ' + m); process.exit(1) }
console.log(`ok gate-selftest: ${breaks.length} breaks, each one caught; the unbroken copy passes`)
